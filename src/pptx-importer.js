/*
 * Artstr Studio — PPTX importer
 *
 * Canonical spec: docs/PPTX_IMPORT_FEATURE.md
 *
 * Lazy-loaded on the first click of the Import PPTX button. Depends
 * on src/vendor/fflate.min.js being loaded first (window.fflate).
 *
 * Phase 1 (current): deck-shell parse — file → unzip → presentation.xml
 * → slide order → one empty Artstr deck slide per PowerPoint slide,
 * normalized to a 1920x1080 canvas. No layer extraction yet. Slide
 * count + slide order are the load-bearing things at this phase.
 */

window.ArtstrPptxImporter = (function () {
  'use strict';

  // ---- Constants --------------------------------------------------------
  const PPTX_IMAGE_PLACEHOLDER_URL =
    'https://i.postimg.cc/9fY3n60q/example-image-replace-me.png';
  const RELATIONSHIPS_NS =
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  // Default to 16:9 widescreen (12192000 x 6858000 EMU = 13.33in x 7.5in)
  // when presentation.xml omits p:sldSz. Standard PowerPoint widescreen
  // template default.
  const DEFAULT_PPTX_SLIDE_SIZE = { cx: 12192000, cy: 6858000 };
  const TARGET_W = 1920;
  const TARGET_H = 1080;
  // Anything above this prints a friendly warning rather than crashing —
  // matches the spec's PPTX_MAX_SLIDES_WARN.
  const SLIDE_COUNT_WARN_AT = 100;
  // PPTX a:ln@w stroke width is in EMU; 1 pt = 12700 EMU. We convert to
  // pixels by multiplying by the slide-scale; the average of x/y scale
  // is fine since strokes are uniform in practice.
  const EMU_PER_PT = 12700;
  // Preset-shape mapping. Anything not in this table falls back to
  // 'rect' with an UNSUPPORTED_SHAPE_APPROXIMATED warning. Phase 6 can
  // add a:custGeom → custom SVG-path conversion for finer fidelity.
  const PPTX_PRST_TO_ARTSTR = {
    rect: { kind: 'rect' },
    roundRect: { kind: 'rounded-rect', cornerRadius: 12 },
    ellipse: { kind: 'ellipse' },
    triangle: { kind: 'triangle' },
    line: { kind: 'line', x1: 0, y1: 50, x2: 100, y2: 50, strokeWidth: 6 },
    straightConnector1: { kind: 'line', x1: 0, y1: 50, x2: 100, y2: 50, strokeWidth: 6 },
    star5: { kind: 'star', points: 5, innerRadiusRatio: 0.45 },
    hexagon: { kind: 'polygon', sides: 6 },
    pentagon: { kind: 'polygon', sides: 5 },
  };
  const PRESET_NAME_LABEL = {
    rect: 'Rectangle',
    roundRect: 'Rounded rectangle',
    ellipse: 'Ellipse',
    triangle: 'Triangle',
    line: 'Line',
    straightConnector1: 'Line',
    star5: 'Star',
    hexagon: 'Hexagon',
    pentagon: 'Pentagon',
  };

  // ---- Report -----------------------------------------------------------
  function makePptxImportReport(fileName) {
    return {
      fileName: fileName || '',
      slideCount: 0,
      imported: {
        text: 0,
        images: 0,
        shapes: 0,
        groups: 0,
        backgrounds: 0,
        notes: 0,
      },
      placeholders: {
        charts: 0,
        smartArt: 0,
        tables: 0,
        media: 0,
        unknown: 0,
      },
      warnings: [],
    };
  }

  function _warn(report, slideIndex, code, message) {
    if (!report || !Array.isArray(report.warnings)) return;
    report.warnings.push({ slideIndex, code, message });
  }

  // ---- XML helpers ------------------------------------------------------
  function parseXml(xmlText) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'application/xml');
    // DOMParser surfaces XML parse errors as a <parsererror> element
    // rather than throwing. Detect and re-throw so callers see a real
    // error instead of a quietly malformed document.
    const err = doc.getElementsByTagName('parsererror')[0];
    if (err) throw new Error('Could not parse PPTX XML: ' + (err.textContent || 'unknown').slice(0, 200));
    return doc;
  }

  // ---- Zip helpers ------------------------------------------------------
  async function readPptxPackage(file) {
    if (!file) throw new Error('No file provided.');
    if (!window.fflate?.unzipSync) {
      throw new Error('fflate is not loaded — call ensurePptxImporterLoaded first.');
    }
    const buf = await file.arrayBuffer();
    const u8 = new Uint8Array(buf);
    // Synchronous unzip blocks the UI briefly for large decks but is
    // simpler than fflate.unzip's callback-based async API. Typical
    // 1–10 MB pptx files unzip in well under 200 ms on a modern laptop.
    return window.fflate.unzipSync(u8);
  }

  function readZipText(files, path) {
    const bytes = files[path];
    if (!bytes) return null;
    return new TextDecoder('utf-8').decode(bytes);
  }

  // Resolve an OOXML relationship Target against the part that owned the
  // relationship file. Examples:
  //   pptxTargetToZipPath('ppt/presentation.xml', 'slides/slide1.xml')
  //     => 'ppt/slides/slide1.xml'
  //   pptxTargetToZipPath('ppt/slides/slide1.xml', '../media/image1.png')
  //     => 'ppt/media/image1.png'
  //   pptxTargetToZipPath(anything, '/ppt/media/image1.png')
  //     => 'ppt/media/image1.png'   (absolute-in-package)
  function pptxTargetToZipPath(basePath, target) {
    if (!target) return '';
    if (target.startsWith('/')) return target.replace(/^\/+/, '');
    const baseDir = basePath.replace(/[^/]+$/, '');
    const combined = baseDir + target;
    const parts = [];
    for (const seg of combined.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { parts.pop(); continue; }
      parts.push(seg);
    }
    return parts.join('/');
  }

  // ---- Presentation parsing --------------------------------------------
  function readSlideSize(presDoc) {
    const sldSz = presDoc.getElementsByTagName('p:sldSz')[0]
              || presDoc.getElementsByTagNameNS('*', 'sldSz')[0];
    if (!sldSz) return { ...DEFAULT_PPTX_SLIDE_SIZE };
    const cx = Number(sldSz.getAttribute('cx')) || DEFAULT_PPTX_SLIDE_SIZE.cx;
    const cy = Number(sldSz.getAttribute('cy')) || DEFAULT_PPTX_SLIDE_SIZE.cy;
    return { cx, cy };
  }

  // Walk <p:sldIdLst> for the canonical slide order, then resolve each
  // <p:sldId r:id="..."/> against ppt/_rels/presentation.xml.rels to get
  // the actual zip path of the slide XML.
  function readSlideRefsInOrder(presDoc, presRelsDoc) {
    const sldIdLst = presDoc.getElementsByTagName('p:sldIdLst')[0]
                 || presDoc.getElementsByTagNameNS('*', 'sldIdLst')[0];
    if (!sldIdLst) return [];

    const relIdToTarget = new Map();
    const rels = presRelsDoc.getElementsByTagName('Relationship');
    for (let i = 0; i < rels.length; i++) {
      const r = rels[i];
      const id = r.getAttribute('Id');
      const tgt = r.getAttribute('Target');
      if (id && tgt) relIdToTarget.set(id, tgt);
    }

    const refs = [];
    for (let i = 0; i < sldIdLst.children.length; i++) {
      const sldId = sldIdLst.children[i];
      if (sldId.localName !== 'sldId') continue;
      const rId = sldId.getAttributeNS(RELATIONSHIPS_NS, 'id')
              || sldId.getAttribute('r:id')
              || '';
      if (!rId) continue;
      const target = relIdToTarget.get(rId);
      if (!target) continue;
      refs.push({
        rId,
        path: pptxTargetToZipPath('ppt/presentation.xml', target),
      });
    }
    return refs;
  }

  // ---- Color / fill / stroke helpers ------------------------------------
  // Read a:srgbClr → '#rrggbb'. Returns null for scheme colors, preset
  // colors, system colors, or anything else we can't resolve in this
  // phase (theme resolution lands in Phase 6).
  function convertColor(colorParentNode) {
    if (!colorParentNode) return null;
    const srgb = colorParentNode.getElementsByTagName('a:srgbClr')[0]
              || colorParentNode.getElementsByTagNameNS('*', 'srgbClr')[0];
    if (!srgb) return null;
    const hex = (srgb.getAttribute('val') || '').trim().toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(hex)) return null;
    return '#' + hex;
  }

  // Read a:solidFill from inside a spPr / ln node. Returns Artstr fill
  // descriptor or null when no fill is set, or { type: 'none' } when
  // an explicit a:noFill is present.
  function readFill(spPrNode) {
    if (!spPrNode) return null;
    const noFill = spPrNode.getElementsByTagName('a:noFill')[0]
                || spPrNode.getElementsByTagNameNS('*', 'noFill')[0];
    // Make sure the noFill is a direct child of spPr (not nested in a:ln).
    if (noFill && noFill.parentNode === spPrNode) return { type: 'none' };
    const solid = _directChild(spPrNode, 'solidFill');
    if (!solid) return null;
    const color = convertColor(solid);
    if (!color) return null;
    return { type: 'solid', color };
  }

  // Read a:ln (line / stroke) from inside spPr. Stroke width is in EMU
  // (a:ln@w); convert to px using the slide scale's geometric mean.
  function readStroke(spPrNode, scale) {
    if (!spPrNode) return null;
    const ln = _directChild(spPrNode, 'ln');
    if (!ln) return null;
    const wEmu = Number(ln.getAttribute('w')) || 0;
    const pxScale = (scale.x + scale.y) / 2;
    // PPTX line widths can be 0 (hairline) — fall back to 1 px so we
    // don't render an invisible 0-width stroke.
    const width = Math.max(1, Math.round(wEmu * pxScale));
    // Explicit noFill on the line means "no stroke".
    const lnNoFill = _directChild(ln, 'noFill');
    if (lnNoFill) return { type: 'none', color: '#000000', width, dash: 'solid' };
    const solid = _directChild(ln, 'solidFill');
    if (!solid) return null;
    const color = convertColor(solid);
    if (!color) return null;
    // a:prstDash → Artstr dash. Map the three styles Artstr supports.
    const prstDash = _directChild(ln, 'prstDash');
    const dashVal = prstDash?.getAttribute('val') || 'solid';
    const dash = (dashVal === 'dash' || dashVal === 'dashDot' || dashVal === 'lgDash' || dashVal === 'lgDashDot' || dashVal === 'lgDashDotDot' || dashVal === 'sysDash' || dashVal === 'sysDashDot' || dashVal === 'sysDashDotDot')
      ? 'dashed'
      : (dashVal === 'dot' || dashVal === 'sysDot')
        ? 'dotted'
        : 'solid';
    return { type: 'solid', color, width, dash };
  }

  // Direct-child element helper: getElementsByTagName recurses, but we
  // often want only the immediate child to avoid picking up a nested
  // fill that lives on the line / inside a gradient stop.
  function _directChild(node, localName) {
    if (!node) return null;
    for (let i = 0; i < node.children.length; i++) {
      if (node.children[i].localName === localName) return node.children[i];
    }
    return null;
  }

  // ---- Transform helpers ----------------------------------------------
  function readXfrm(xfrmNode, scale) {
    if (!xfrmNode) return null;
    const off = _directChild(xfrmNode, 'off');
    const ext = _directChild(xfrmNode, 'ext');
    if (!off || !ext) return null;
    const x = (Number(off.getAttribute('x')) || 0) * scale.x;
    const y = (Number(off.getAttribute('y')) || 0) * scale.y;
    const w = (Number(ext.getAttribute('cx')) || 0) * scale.x;
    const h = (Number(ext.getAttribute('cy')) || 0) * scale.y;
    // a:xfrm@rot is in 1/60000 degree units.
    const rotRaw = Number(xfrmNode.getAttribute('rot')) || 0;
    const rotate = rotRaw / 60000;
    return { x, y, w, h, rotate };
  }

  // ---- Slide-level parsing ---------------------------------------------
  // Read the slide's direct background. PPTX backgrounds can come from
  // four places (slide, layout, master, theme). This handler covers only
  // the direct slide background with a single solidFill — the common case
  // for design-template decks. Layout / master / theme inheritance and
  // gradient / picture fills are Phase 6.
  //
  // Returns either a CSS hex string like '#fbf8f0' or null if nothing
  // usable was found (caller leaves slide.background at the default).
  function readSlideBackground(slideDoc, slideIndex, report) {
    const bg = slideDoc.getElementsByTagName('p:bg')[0]
           || slideDoc.getElementsByTagNameNS('*', 'bg')[0];
    if (!bg) return null;

    // Direct background properties live in <p:bgPr>. <p:bgRef> means the
    // slide inherits from its layout/master via a theme scheme — defer
    // to Phase 6 with a warning.
    const bgRef = bg.getElementsByTagName('p:bgRef')[0]
              || bg.getElementsByTagNameNS('*', 'bgRef')[0];
    if (bgRef) {
      _warn(report, slideIndex, 'LAYOUT_INHERITANCE_PARTIAL',
        `Slide ${slideIndex + 1}: background inherited from layout/master — not resolved in Phase 1.`);
      return null;
    }

    const bgPr = bg.getElementsByTagName('p:bgPr')[0]
             || bg.getElementsByTagNameNS('*', 'bgPr')[0];
    if (!bgPr) return null;

    // Only solidFill + srgbClr in Phase 1. gradFill, blipFill (picture),
    // pattFill, and schemeClr-based fills land in Phase 6 with the rest
    // of theme resolution.
    const solid = bgPr.getElementsByTagName('a:solidFill')[0]
              || bgPr.getElementsByTagNameNS('*', 'solidFill')[0];
    if (!solid) {
      _warn(report, slideIndex, 'THEME_COLOR_UNRESOLVED',
        `Slide ${slideIndex + 1}: non-solid background fill (gradient / picture / scheme color) — left as default for now.`);
      return null;
    }

    const srgb = solid.getElementsByTagName('a:srgbClr')[0]
              || solid.getElementsByTagNameNS('*', 'srgbClr')[0];
    if (!srgb) {
      _warn(report, slideIndex, 'THEME_COLOR_UNRESOLVED',
        `Slide ${slideIndex + 1}: background uses a scheme color — theme resolution is Phase 6.`);
      return null;
    }
    const hex = (srgb.getAttribute('val') || '').trim().toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(hex)) return null;
    return '#' + hex;
  }

  // ---- Shape conversion -----------------------------------------------
  // Per-import counter so two consecutive imports don't generate
  // colliding layer ids. Reset at the start of importPptxFile.
  let _layerIdCounter = 0;
  function _makePptxLayerId() {
    _layerIdCounter += 1;
    return 'pptx-' + Date.now().toString(36) + '-' + _layerIdCounter;
  }

  // Returns an Artstr shape layer for a p:sp with a:prstGeom, or null
  // if the shape should be skipped (text-bodied — Phase 2 handles it).
  // Unknown preset names fall back to a rectangle with a warning.
  function convertPresetShape(spNode, ctx) {
    // Phase 4 doesn't try to convert text shapes — let Phase 2 turn
    // those into text layers. A shape with both prstGeom and txBody is
    // a text shape (e.g. a title placeholder), so skip here.
    const txBody = _directChild(spNode, 'txBody');
    if (txBody) return null;

    const spPr = _directChild(spNode, 'spPr');
    if (!spPr) return null;
    const xfrm = _directChild(spPr, 'xfrm');
    const prstGeom = _directChild(spPr, 'prstGeom');
    if (!xfrm || !prstGeom) return null;

    const bounds = readXfrm(xfrm, ctx.scale);
    if (!bounds || bounds.w <= 0 || bounds.h <= 0) return null;

    const prst = prstGeom.getAttribute('prst') || 'rect';
    let shape = PPTX_PRST_TO_ARTSTR[prst];
    let label = PRESET_NAME_LABEL[prst];
    if (!shape) {
      _warn(ctx.report, ctx.slideIndex, 'UNSUPPORTED_SHAPE_APPROXIMATED',
        `Slide ${ctx.slideIndex + 1}: shape "${prst}" approximated as a rectangle.`);
      shape = { kind: 'rect' };
      label = 'Shape (' + prst + ')';
    }
    // Shallow-clone so subsequent shapes don't mutate the shared template.
    shape = { ...shape };

    // Name the layer with PowerPoint's <p:cNvPr name="..."> if present so
    // the user can match it back to the source deck in the layer panel.
    const cNvPr = spNode.getElementsByTagName('p:cNvPr')[0]
              || spNode.getElementsByTagNameNS('*', 'cNvPr')[0];
    const sourceName = cNvPr?.getAttribute('name') || '';
    const name = sourceName ? `${label || 'Shape'} (${sourceName})` : (label || 'Shape');

    const fill = readFill(spPr) || { type: 'none' };
    const stroke = readStroke(spPr, ctx.scale) || { type: 'none', color: '#000000', width: 1, dash: 'solid' };

    return {
      id: _makePptxLayerId(),
      type: 'shape',
      name,
      target: 'canvas',
      x: bounds.x,
      y: bounds.y,
      w: bounds.w,
      h: bounds.h,
      rotate: bounds.rotate || 0,
      opacity: 1,
      z: ctx.nextZ++,
      shape,
      fill,
      stroke,
    };
  }

  // Walk the slide's p:cSld/p:spTree and emit Artstr layers in document
  // order. Top-level only for Phase 4 — p:grpSp (groups) become layers
  // in Phase 5; p:pic / p:graphicFrame are Phase 3.
  function walkSpTree(spTreeNode, ctx, layersOut) {
    if (!spTreeNode) return;
    for (let i = 0; i < spTreeNode.children.length; i++) {
      const child = spTreeNode.children[i];
      if (child.localName === 'sp') {
        const layer = convertPresetShape(child, ctx);
        if (layer) {
          layersOut.push(layer);
          ctx.report.imported.shapes += 1;
        }
      }
      // Future phases:
      //   - 'pic'           → image placeholder (Phase 3)
      //   - 'graphicFrame'  → chart / table / SmartArt placeholder (Phase 3)
      //   - 'grpSp'         → group (Phase 5 — recurse with combined xfrm)
    }
  }

  function readPresentationInfo(files, report) {
    const presText = readZipText(files, 'ppt/presentation.xml');
    if (!presText) {
      throw new Error('Missing ppt/presentation.xml — file does not look like a valid .pptx package.');
    }
    const presDoc = parseXml(presText);

    const presRelsText = readZipText(files, 'ppt/_rels/presentation.xml.rels');
    if (!presRelsText) {
      throw new Error('Missing ppt/_rels/presentation.xml.rels — relationship metadata missing.');
    }
    const presRelsDoc = parseXml(presRelsText);

    const slideSize = readSlideSize(presDoc);
    const slideRefs = readSlideRefsInOrder(presDoc, presRelsDoc);

    if (slideRefs.length > SLIDE_COUNT_WARN_AT) {
      _warn(report, -1, 'LARGE_DECK',
        `Large deck: ${slideRefs.length} slides. Import may take a moment.`);
    }

    return { slideSize, slideRefs };
  }

  // ---- Phase 1: deck shell ---------------------------------------------
  async function importPptxFile(file, report) {
    if (!file) throw new Error('No file provided.');
    if (!report) report = makePptxImportReport(file.name);

    const files = await readPptxPackage(file);
    const presentation = readPresentationInfo(files, report);
    const scale = {
      x: TARGET_W / presentation.slideSize.cx,
      y: TARGET_H / presentation.slideSize.cy,
    };
    _layerIdCounter = 0;

    const slides = [];
    for (let i = 0; i < presentation.slideRefs.length; i++) {
      // Yield to the browser every 10 slides so a 50+ slide deck doesn't
      // freeze the UI thread during import.
      if (i && i % 10 === 0) {
        await new Promise((r) => requestAnimationFrame(r));
      }

      // Try to read the slide's direct background. Anything we can't
      // resolve (inherited, gradient, scheme color) leaves the default
      // white — the user can edit it in the Deck Builder. Read failures
      // are non-fatal: the slide still gets a shell.
      let background = '#ffffff';
      const layers = [];
      const slidePath = presentation.slideRefs[i].path;
      const slideText = slidePath ? readZipText(files, slidePath) : null;
      if (slideText) {
        try {
          const slideDoc = parseXml(slideText);
          const bg = readSlideBackground(slideDoc, i, report);
          if (bg) {
            background = bg;
            report.imported.backgrounds += 1;
          }
          // Walk the shape tree and convert each p:sp with prstGeom into
          // an Artstr shape layer. Phase 2 will fill in text; Phase 3
          // fills in images / chart placeholders; Phase 5 flattens groups.
          const spTree = slideDoc.getElementsByTagName('p:spTree')[0]
                     || slideDoc.getElementsByTagNameNS('*', 'spTree')[0];
          const ctx = { scale, slideIndex: i, report, nextZ: 0 };
          walkSpTree(spTree, ctx, layers);
        } catch (err) {
          _warn(report, i, 'SLIDE_PARSE_FAILED',
            `Slide ${i + 1}: could not parse slide XML — left blank.`);
        }
      }

      slides.push({
        name: 'Slide ' + (i + 1),
        slide: {
          width: TARGET_W,
          height: TARGET_H,
          background,
          notes: '',
        },
        layers,
        ignoreDeckTheme: true,
      });
    }
    report.slideCount = slides.length;

    return {
      version: 5,
      templateMode: 'deck',
      templateType: 'deck',
      meta: {
        title: file.name.replace(/\.pptx$/i, ''),
        imdbId: '',
        upc: '',
        tvdbId: '',
        musicbrainzDiscId: '',
        customTag: '',
        category: 'presentation',
        language: 'en',
      },
      deck: {
        theme: { fontFamily: '', background: '' },
        slides,
      },
    };
  }

  return {
    PPTX_IMAGE_PLACEHOLDER_URL,
    makePptxImportReport,
    importPptxFile,
    // Exposed for unit tests / future phases.
    _internals: {
      parseXml,
      readPptxPackage,
      readZipText,
      pptxTargetToZipPath,
      readSlideSize,
      readSlideRefsInOrder,
      readPresentationInfo,
      readSlideBackground,
      convertColor,
      readFill,
      readStroke,
      readXfrm,
      convertPresetShape,
      walkSpTree,
    },
  };
})();
