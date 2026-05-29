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
  // Artstr deck slides advertise their canvas as 1920x1080 (in slide.width
  // / slide.height), but internally the engine converts that to inches by
  // dividing by 96 — and *layer* coordinates (x/y/w/h, stroke width) live
  // in those inches. So we keep TARGET_W/TARGET_H as the pixel-ish numbers
  // that go into slide.width, and use TARGET_W_IN/TARGET_H_IN as the
  // EMU→layer scale denominator.
  const TARGET_W = 1920;
  const TARGET_H = 1080;
  const PX_PER_IN = 96;
  const TARGET_W_IN = TARGET_W / PX_PER_IN; // 20
  const TARGET_H_IN = TARGET_H / PX_PER_IN; // 11.25
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

  // ---- Theme resolution -------------------------------------------------
  // The PPTX inheritance chain (per NIP— sorry, per OOXML §19) is:
  //   slide → slideLayout → slideMaster → theme.
  // Each step is a separate part with its own _rels file; we chase the
  // chain once per slide and cache the parsed theme by zip path so a
  // 50-slide deck sharing one theme doesn't reparse the XML 50 times.
  // Phase 6 resolves the color scheme (accent1..6, dk1/2, lt1/2 + the
  // bg/tx aliases) and inherited slide backgrounds; font scheme is
  // Phase 7.
  const _themeCache = new Map();

  // Color-scheme alias map (bg/tx are aliases for the lt/dk pairs in
  // light themes — which is the default and what 99% of decks use).
  const SCHEME_ALIASES = {
    bg1: 'lt1',
    bg2: 'lt2',
    tx1: 'dk1',
    tx2: 'dk2',
  };

  function _firstRelTarget(relsDoc, typeSuffix) {
    if (!relsDoc) return '';
    const rels = relsDoc.getElementsByTagName('Relationship');
    for (let i = 0; i < rels.length; i++) {
      const type = rels[i].getAttribute('Type') || '';
      if (type.endsWith(typeSuffix)) return rels[i].getAttribute('Target') || '';
    }
    return '';
  }

  function _readRelsAt(files, path) {
    const text = readZipText(files, path);
    if (!text) return null;
    try { return parseXml(text); } catch { return null; }
  }

  // Returns { colors: { accent1:'#...', dk1:'#...', ... }, themePath }
  // or null when no theme is reachable from this slide.
  function loadThemeForSlide(files, slidePath) {
    if (!slidePath) return null;
    // slide → slideLayout
    const sm = slidePath.match(/^(.*\/)([^/]+)$/);
    if (!sm) return null;
    const slideRelsDoc = _readRelsAt(files, `${sm[1]}_rels/${sm[2]}.rels`);
    const layoutTarget = _firstRelTarget(slideRelsDoc, '/slideLayout');
    if (!layoutTarget) return null;
    const layoutPath = pptxTargetToZipPath(slidePath, layoutTarget);

    // slideLayout → slideMaster
    const lm = layoutPath.match(/^(.*\/)([^/]+)$/);
    if (!lm) return null;
    const layoutRelsDoc = _readRelsAt(files, `${lm[1]}_rels/${lm[2]}.rels`);
    const masterTarget = _firstRelTarget(layoutRelsDoc, '/slideMaster');
    if (!masterTarget) return null;
    const masterPath = pptxTargetToZipPath(layoutPath, masterTarget);

    // slideMaster → theme
    const mm = masterPath.match(/^(.*\/)([^/]+)$/);
    if (!mm) return null;
    const masterRelsDoc = _readRelsAt(files, `${mm[1]}_rels/${mm[2]}.rels`);
    const themeTarget = _firstRelTarget(masterRelsDoc, '/theme');
    if (!themeTarget) return null;
    const themePath = pptxTargetToZipPath(masterPath, themeTarget);

    if (_themeCache.has(themePath)) {
      const cached = _themeCache.get(themePath);
      return cached ? { ...cached, layoutPath, masterPath } : null;
    }

    const themeDoc = _readRelsAt(files, themePath);
    if (!themeDoc) { _themeCache.set(themePath, null); return null; }
    // Walk a:clrScheme/*. Each child element's localName is the slot
    // name ('accent1', 'dk1', etc.), and its child is either srgbClr
    // or sysClr (which carries a lastClr fallback hex).
    const clrScheme = themeDoc.getElementsByTagName('a:clrScheme')[0]
                   || themeDoc.getElementsByTagNameNS('*', 'clrScheme')[0];
    const colors = {};
    if (clrScheme) {
      for (let i = 0; i < clrScheme.children.length; i++) {
        const slot = clrScheme.children[i];
        const slotName = slot.localName;
        if (!slotName) continue;
        // Most slots wrap a single srgbClr or sysClr child.
        const srgb = _directChild(slot, 'srgbClr');
        const sysClr = _directChild(slot, 'sysClr');
        let hex = '';
        if (srgb) {
          hex = (srgb.getAttribute('val') || '').trim().toLowerCase();
        } else if (sysClr) {
          // sysClr@lastClr is the resolved hex of the last time the file
          // was rendered — a good enough proxy here.
          hex = (sysClr.getAttribute('lastClr') || '').trim().toLowerCase();
        }
        if (/^[0-9a-f]{6}$/.test(hex)) colors[slotName] = '#' + hex;
      }
    }
    const out = { colors, themePath };
    _themeCache.set(themePath, out);
    return { ...out, layoutPath, masterPath };
  }

  // Map an a:schemeClr name to a hex via the theme, honoring the
  // bg/tx → lt/dk aliases.
  function _resolveSchemeName(name, theme) {
    if (!theme || !theme.colors) return null;
    const resolved = SCHEME_ALIASES[name] || name;
    return theme.colors[resolved] || theme.colors[name] || null;
  }

  // ---- Color modifier math (lumMod / lumOff / tint / shade) -----------
  // Operates in HSL. PPTX modifier values are in 1/1000 of a percent
  // (so 60000 = 60%, 100000 = 100%).
  function _hexToRgb(hex) {
    return {
      r: parseInt(hex.slice(1, 3), 16) / 255,
      g: parseInt(hex.slice(3, 5), 16) / 255,
      b: parseInt(hex.slice(5, 7), 16) / 255,
    };
  }
  function _rgbToHex(r, g, b) {
    const c = (n) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0');
    return '#' + c(r) + c(g) + c(b);
  }
  function _rgbToHsl({ r, g, b }) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r)      h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else                h = ((r - g) / d + 4) / 6;
    return { h, s, l };
  }
  function _hslToRgb({ h, s, l }) {
    if (s === 0) return { r: l, g: l, b: l };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const h2rgb = (t) => {
      t = (t + 1) % 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return { r: h2rgb(h + 1 / 3), g: h2rgb(h), b: h2rgb(h - 1 / 3) };
  }
  // Read modifier children of a color element (srgbClr / schemeClr /
  // sysClr) and return their values as fractions (0..1).
  function _readColorModifiers(colorNode) {
    const out = {};
    if (!colorNode) return out;
    for (let i = 0; i < colorNode.children.length; i++) {
      const ch = colorNode.children[i];
      const name = ch.localName;
      const v = Number(ch.getAttribute('val')) / 100000;
      if (!Number.isFinite(v)) continue;
      if (name === 'lumMod') out.lumMod = v;
      else if (name === 'lumOff') out.lumOff = v;
      else if (name === 'tint') out.tint = v;
      else if (name === 'shade') out.shade = v;
    }
    return out;
  }
  function _applyColorModifiers(hex, mods) {
    if (!hex || !mods) return hex;
    if (mods.lumMod == null && mods.lumOff == null && mods.tint == null && mods.shade == null) return hex;
    const hsl = _rgbToHsl(_hexToRgb(hex));
    if (mods.lumMod != null) hsl.l *= mods.lumMod;
    if (mods.lumOff != null) hsl.l += mods.lumOff;
    if (mods.tint != null)   hsl.l = hsl.l * (1 - mods.tint) + mods.tint;       // toward white
    if (mods.shade != null)  hsl.l = hsl.l * mods.shade;                        // toward black
    hsl.l = Math.max(0, Math.min(1, hsl.l));
    const rgb = _hslToRgb(hsl);
    return _rgbToHex(rgb.r, rgb.g, rgb.b);
  }

  // ---- Color / fill / stroke helpers ------------------------------------
  // Read a color element (srgbClr / schemeClr / sysClr) into hex, with
  // PPTX color modifiers (lumMod / lumOff / tint / shade) applied
  // approximately in HSL. The optional `theme` argument lets schemeClr
  // names resolve through the slide's inheritance chain (Phase 6).
  // Returns null for preset colors and anything else we can't reach.
  function convertColor(colorParentNode, theme) {
    if (!colorParentNode) return null;
    // The parent can either be the color element itself (when called
    // directly on a:srgbClr in some paths) or a wrapper containing one.
    const candidates = [colorParentNode];
    for (let i = 0; i < colorParentNode.children.length; i++) {
      candidates.push(colorParentNode.children[i]);
    }
    for (const node of candidates) {
      const ln = node.localName;
      let hex = null;
      let modSource = null;
      if (ln === 'srgbClr') {
        const v = (node.getAttribute('val') || '').trim().toLowerCase();
        if (/^[0-9a-f]{6}$/.test(v)) { hex = '#' + v; modSource = node; }
      } else if (ln === 'schemeClr') {
        const name = (node.getAttribute('val') || '').trim();
        const resolved = _resolveSchemeName(name, theme);
        if (resolved) { hex = resolved; modSource = node; }
      } else if (ln === 'sysClr') {
        const last = (node.getAttribute('lastClr') || '').trim().toLowerCase();
        if (/^[0-9a-f]{6}$/.test(last)) { hex = '#' + last; modSource = node; }
      }
      if (hex) {
        const mods = _readColorModifiers(modSource);
        return _applyColorModifiers(hex, mods);
      }
    }
    return null;
  }

  // Read a:solidFill from inside a spPr / ln node. Returns Artstr fill
  // descriptor or null when no fill is set, or { type: 'none' } when
  // an explicit a:noFill is present.
  function readFill(spPrNode, theme) {
    if (!spPrNode) return null;
    const noFill = spPrNode.getElementsByTagName('a:noFill')[0]
                || spPrNode.getElementsByTagNameNS('*', 'noFill')[0];
    // Make sure the noFill is a direct child of spPr (not nested in a:ln).
    if (noFill && noFill.parentNode === spPrNode) return { type: 'none' };
    const solid = _directChild(spPrNode, 'solidFill');
    if (!solid) return null;
    const color = convertColor(solid, theme);
    if (!color) return null;
    return { type: 'solid', color };
  }

  // Read a:ln (line / stroke) from inside spPr. PPTX a:ln@w is in EMU;
  // convert through the slide scale (inches per EMU) to land in Artstr's
  // inch-based layer coord system. Minimum visible width is ~1 pixel
  // equivalent (1/96 inch) so a 0-width hairline still renders.
  function readStroke(spPrNode, scale, theme) {
    if (!spPrNode) return null;
    const ln = _directChild(spPrNode, 'ln');
    if (!ln) return null;
    const wEmu = Number(ln.getAttribute('w')) || 0;
    const inPerEmu = (scale.x + scale.y) / 2;
    const widthIn = wEmu * inPerEmu;
    const width = Math.max(1 / PX_PER_IN, widthIn);
    // Explicit noFill on the line means "no stroke".
    const lnNoFill = _directChild(ln, 'noFill');
    if (lnNoFill) return { type: 'none', color: '#000000', width, dash: 'solid' };
    const solid = _directChild(ln, 'solidFill');
    if (!solid) return null;
    const color = convertColor(solid, theme);
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
  // A "group transform" maps child-EMU coordinates (the coord space
  // inside a p:grpSp) into slide-EMU coordinates (the coord space the
  // slide's own scale expects). The identity transform leaves EMU as-is
  // — used when reading a top-level shape that has no ancestor group.
  const IDENTITY_GROUP_XFRM = { offX: 0, offY: 0, sX: 1, sY: 1 };

  // Compose a new group transform when entering a p:grpSp from inside
  // the existing transform. PPTX semantics: the group's a:xfrm/a:off +
  // a:ext say where the group sits + how big it is in its parent's
  // child-coord space, while a:chOff + a:chExt define the child-coord
  // space *inside* this group. The composed transform converts that
  // inner space to slide-EMU.
  function enterGroup(parentTransform, groupXfrmNode) {
    if (!groupXfrmNode) return parentTransform;
    const off = _directChild(groupXfrmNode, 'off');
    const ext = _directChild(groupXfrmNode, 'ext');
    if (!off || !ext) return parentTransform;
    const px = Number(off.getAttribute('x')) || 0;
    const py = Number(off.getAttribute('y')) || 0;
    const pcx = Number(ext.getAttribute('cx')) || 0;
    const pcy = Number(ext.getAttribute('cy')) || 0;
    // Group's slide-EMU origin / size.
    const groupSlideX = parentTransform.offX + px * parentTransform.sX;
    const groupSlideY = parentTransform.offY + py * parentTransform.sY;
    const groupExtCx  = pcx * parentTransform.sX;
    const groupExtCy  = pcy * parentTransform.sY;
    // Child-coord space defined by chOff / chExt (default to 0 / group ext).
    const chOff = _directChild(groupXfrmNode, 'chOff');
    const chExt = _directChild(groupXfrmNode, 'chExt');
    const childOffX = chOff ? (Number(chOff.getAttribute('x')) || 0) : 0;
    const childOffY = chOff ? (Number(chOff.getAttribute('y')) || 0) : 0;
    const childExtCx = chExt ? (Number(chExt.getAttribute('cx')) || 0) : pcx;
    const childExtCy = chExt ? (Number(chExt.getAttribute('cy')) || 0) : pcy;
    if (!childExtCx || !childExtCy || !groupExtCx || !groupExtCy) return parentTransform;
    const sX = groupExtCx / childExtCx;
    const sY = groupExtCy / childExtCy;
    return {
      offX: groupSlideX - childOffX * sX,
      offY: groupSlideY - childOffY * sY,
      sX,
      sY,
    };
  }

  // readXfrm transforms an a:xfrm element to Artstr inches, going
  // through any accumulated group transform first so a shape inside
  // nested p:grpSp lands at the right slide-relative position.
  function readXfrm(xfrmNode, scale, groupXfrm = IDENTITY_GROUP_XFRM) {
    if (!xfrmNode) return null;
    const off = _directChild(xfrmNode, 'off');
    const ext = _directChild(xfrmNode, 'ext');
    if (!off || !ext) return null;
    const childX = Number(off.getAttribute('x')) || 0;
    const childY = Number(off.getAttribute('y')) || 0;
    const childCx = Number(ext.getAttribute('cx')) || 0;
    const childCy = Number(ext.getAttribute('cy')) || 0;
    // child EMU → slide EMU → inches.
    const slideX = groupXfrm.offX + childX * groupXfrm.sX;
    const slideY = groupXfrm.offY + childY * groupXfrm.sY;
    const slideCx = childCx * groupXfrm.sX;
    const slideCy = childCy * groupXfrm.sY;
    const rotRaw = Number(xfrmNode.getAttribute('rot')) || 0;
    return {
      x: slideX * scale.x,
      y: slideY * scale.y,
      w: slideCx * scale.x,
      h: slideCy * scale.y,
      rotate: rotRaw / 60000,
    };
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
  // Resolve a p:bg/p:bgPr/a:solidFill into a hex via the theme. Returns
  // null when there's no solid fill (gradient / picture / etc.) — these
  // are still Phase 7+ work.
  function _readBackgroundFromBgNode(bgNode, theme) {
    if (!bgNode) return null;
    const bgPr = _directChild(bgNode, 'bgPr');
    if (!bgPr) return null;
    const solid = _directChild(bgPr, 'solidFill');
    if (!solid) return null;
    return convertColor(solid, theme);
  }

  function readSlideBackground(slideDoc, slideIndex, report, theme, files, layoutPath, masterPath) {
    // 1) Direct slide background.
    const slideBg = slideDoc.getElementsByTagName('p:bg')[0]
                || slideDoc.getElementsByTagNameNS('*', 'bg')[0];
    const direct = _readBackgroundFromBgNode(slideBg, theme);
    if (direct) return direct;

    // 2) Inherit from slide layout's p:bg, then slide master's p:bg.
    // p:bgRef in the slide explicitly references the layout's bg, but in
    // practice we walk both regardless — whichever has a concrete fill
    // wins.
    for (const path of [layoutPath, masterPath]) {
      if (!path) continue;
      const text = readZipText(files, path);
      if (!text) continue;
      let doc;
      try { doc = parseXml(text); } catch { continue; }
      const bgNode = doc.getElementsByTagName('p:bg')[0]
                 || doc.getElementsByTagNameNS('*', 'bg')[0];
      const inherited = _readBackgroundFromBgNode(bgNode, theme);
      if (inherited) return inherited;
    }
    return null;
  }

  // ---- Text helpers ----------------------------------------------------
  // PPTX alignment vocabulary -> Artstr alignment. Anything else maps to
  // 'left'.
  const PPTX_ALIGN_TO_ARTSTR = {
    l: 'left',
    ctr: 'center',
    r: 'right',
    just: 'justify',
    dist: 'justify',
  };

  function _escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Walk a:r (run) and a:br (line break) children of a paragraph,
  // returning { text, firstRunStyle }. PPTX paragraphs can also contain
  // a:fld (field) runs which we treat like a:r for text extraction.
  function _readParagraphRuns(pNode, theme) {
    let text = '';
    let firstRunStyle = null;
    for (let i = 0; i < pNode.children.length; i++) {
      const child = pNode.children[i];
      const ln = child.localName;
      if (ln === 'r' || ln === 'fld') {
        const t = child.getElementsByTagName('a:t')[0]
              || child.getElementsByTagNameNS('*', 't')[0];
        if (t) text += t.textContent || '';
        if (!firstRunStyle) {
          const rPr = _directChild(child, 'rPr');
          if (rPr) firstRunStyle = _readRunStyle(rPr, theme);
        }
      } else if (ln === 'br') {
        text += '\n';
      }
    }
    return { text, firstRunStyle };
  }

  // Pull the inline style off an a:rPr (run properties) node:
  // size (sz, hundredths of pt), bold (b), italic (i), color, and
  // font family (latin@typeface). Theme-relative colours / fonts are
  // resolved later in Phase 6 — for now we just take what's explicit.
  function _readRunStyle(rPr, theme) {
    if (!rPr) return null;
    const out = {};
    const sz = rPr.getAttribute('sz');
    if (sz) {
      const pt = Number(sz) / 100;
      if (Number.isFinite(pt) && pt > 0) out.fontSize = pt;
    }
    const b = rPr.getAttribute('b');
    if (b === '1' || b === 'true') out.bold = true;
    const i = rPr.getAttribute('i');
    if (i === '1' || i === 'true') out.italic = true;
    const fill = _directChild(rPr, 'solidFill');
    if (fill) {
      const c = convertColor(fill, theme);
      if (c) out.color = c;
    }
    const latin = _directChild(rPr, 'latin');
    if (latin) {
      const tf = latin.getAttribute('typeface') || '';
      // Theme placeholders like '+mj-lt' / '+mn-lt' are theme references
      // — leave fontFamily empty, the editor's default will apply.
      if (tf && tf[0] !== '+') out.fontFamily = tf;
    }
    return out;
  }

  // Read p:txBody → Artstr text layer's html + dominant style.
  // Phase 2 uses the first run's style for the whole text box; per-run
  // rich text is a Phase 7 enhancement.
  function _readTxBody(txBodyNode, theme) {
    if (!txBodyNode) return null;
    const paragraphs = [];
    let dominantStyle = null;
    let alignFromFirstP = null;
    for (let i = 0; i < txBodyNode.children.length; i++) {
      const p = txBodyNode.children[i];
      if (p.localName !== 'p') continue;
      const { text, firstRunStyle } = _readParagraphRuns(p, theme);
      if (!dominantStyle && firstRunStyle) dominantStyle = firstRunStyle;
      // alignment lives on the paragraph (a:pPr@algn); take the first
      // paragraph's alignment as the layer's alignment.
      if (alignFromFirstP === null) {
        const pPr = _directChild(p, 'pPr');
        const algn = pPr?.getAttribute('algn');
        if (algn && PPTX_ALIGN_TO_ARTSTR[algn]) {
          alignFromFirstP = PPTX_ALIGN_TO_ARTSTR[algn];
        }
      }
      paragraphs.push(text);
    }
    const allText = paragraphs.join('\n').trim();
    if (!allText) return null;
    // Escape per-paragraph, then join with <br> (and inline-newline runs
    // contribute their own <br> via the \n we inserted in
    // _readParagraphRuns).
    const html = paragraphs
      .map((p) => _escapeHtml(p).replace(/\n/g, '<br>'))
      .join('<br>');
    return {
      html,
      align: alignFromFirstP || 'left',
      dominantStyle: dominantStyle || {},
      previewText: allText.slice(0, 60),
    };
  }

  // ---- Picture + graphicFrame placeholders -----------------------------
  // PPTX relationship URIs for the OOXML object families we recognize.
  // Anything not in this map becomes an "unknown" placeholder.
  const GRAPHIC_DATA_URI_CHART   = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
  const GRAPHIC_DATA_URI_TABLE   = 'http://schemas.openxmlformats.org/drawingml/2006/table';
  const GRAPHIC_DATA_URI_DIAGRAM = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';

  // Load a slide's relationship file as an rId → Target map so the
  // image converter can resolve a:blip@r:embed values to their original
  // media filenames (used only for the layer `name` — bytes are never
  // decoded; src always points at the static placeholder URL).
  function readSlideRels(files, slidePath) {
    if (!slidePath) return new Map();
    const m = slidePath.match(/^(.*\/)([^/]+)$/);
    if (!m) return new Map();
    const relsPath = `${m[1]}_rels/${m[2]}.rels`;
    const text = readZipText(files, relsPath);
    if (!text) return new Map();
    let doc;
    try { doc = parseXml(text); } catch { return new Map(); }
    const map = new Map();
    const rels = doc.getElementsByTagName('Relationship');
    for (let i = 0; i < rels.length; i++) {
      const id = rels[i].getAttribute('Id');
      const target = rels[i].getAttribute('Target');
      const type = rels[i].getAttribute('Type') || '';
      if (id && target) map.set(id, { target, type });
    }
    return map;
  }

  // Strip the directory and decode any URL-escapes so 'image%201.png'
  // surfaces as 'image 1.png' in the layer name.
  function _basename(p) {
    if (!p) return '';
    const noQuery = p.split(/[?#]/)[0];
    const parts = noQuery.split('/');
    let last = parts[parts.length - 1] || '';
    try { last = decodeURIComponent(last); } catch { /* keep raw */ }
    return last;
  }

  // p:pic → Artstr image layer pointing at the shared placeholder URL.
  // We do NOT read media bytes from the package — the user replaces
  // each placeholder by editing the layer's src after import (see
  // PPTX_IMAGE_PLACEHOLDER_URL in the spec).
  function convertPicture(picNode, ctx) {
    const spPr = _directChild(picNode, 'spPr');
    const xfrm = spPr ? _directChild(spPr, 'xfrm') : null;
    const bounds = readXfrm(xfrm, ctx.scale, ctx.groupXfrm);
    if (!bounds || bounds.w <= 0 || bounds.h <= 0) return null;

    // Resolve the embed-relationship to the original media filename
    // (best-effort — if it's missing we still emit a placeholder).
    const blipFill = _directChild(picNode, 'blipFill');
    const blip = blipFill ? _directChild(blipFill, 'blip') : null;
    const embedId = blip
      ? (blip.getAttributeNS(RELATIONSHIPS_NS, 'embed')
         || blip.getAttribute('r:embed')
         || '')
      : '';
    const rel = embedId ? ctx.slideRels.get(embedId) : null;
    const mediaFile = rel ? _basename(rel.target) : '';

    const cNvPr = picNode.getElementsByTagName('p:cNvPr')[0]
              || picNode.getElementsByTagNameNS('*', 'cNvPr')[0];
    const sourceName = cNvPr?.getAttribute('name') || '';
    const label = mediaFile || sourceName || 'placeholder';
    const name = `Image: ${label}`;

    if (!embedId) {
      _warn(ctx.report, ctx.slideIndex, 'MISSING_IMAGE_RELATIONSHIP',
        `Slide ${ctx.slideIndex + 1}: image has no embed relationship — imported as placeholder.`);
    }

    return {
      id: _makePptxLayerId(),
      type: 'image',
      name,
      target: 'canvas',
      src: PPTX_IMAGE_PLACEHOLDER_URL,
      x: bounds.x,
      y: bounds.y,
      w: bounds.w,
      h: bounds.h,
      rotate: bounds.rotate || 0,
      opacity: 1,
      z: ctx.nextZ++,
    };
  }

  // p:graphicFrame → typed placeholder image layer (chart / table /
  // SmartArt / unknown). We don't try to render the chart or rebuild
  // the table; the user replaces each placeholder with their own
  // image / screenshot / Artstr equivalent.
  function convertGraphicFrame(gfNode, ctx) {
    // graphicFrame puts xfrm directly under itself, not inside spPr.
    const xfrm = _directChild(gfNode, 'xfrm');
    const bounds = readXfrm(xfrm, ctx.scale, ctx.groupXfrm);
    if (!bounds || bounds.w <= 0 || bounds.h <= 0) return null;

    const graphic = _directChild(gfNode, 'graphic');
    const graphicData = graphic ? _directChild(graphic, 'graphicData') : null;
    const uri = graphicData?.getAttribute('uri') || '';

    let kind = 'unknown';
    let warnCode = 'UNSUPPORTED_UNKNOWN_PLACEHOLDER';
    let warnMsg;
    let counterKey = 'unknown';
    let label = 'Unknown object';
    if (uri === GRAPHIC_DATA_URI_CHART) {
      kind = 'chart';
      warnCode = 'UNSUPPORTED_CHART_PLACEHOLDER';
      counterKey = 'charts';
      label = 'Chart';
    } else if (uri === GRAPHIC_DATA_URI_TABLE) {
      kind = 'table';
      warnCode = 'UNSUPPORTED_TABLE_PLACEHOLDER';
      counterKey = 'tables';
      label = 'Table';
    } else if (uri === GRAPHIC_DATA_URI_DIAGRAM) {
      kind = 'smartArt';
      warnCode = 'UNSUPPORTED_SMART_ART_PLACEHOLDER';
      counterKey = 'smartArt';
      label = 'SmartArt';
    }

    const cNvPr = gfNode.getElementsByTagName('p:cNvPr')[0]
              || gfNode.getElementsByTagNameNS('*', 'cNvPr')[0];
    const sourceName = cNvPr?.getAttribute('name') || '';
    const detail = sourceName ? `${label} placeholder: ${sourceName}` : `${label} placeholder`;
    warnMsg = `Slide ${ctx.slideIndex + 1}: ${label.toLowerCase()} was imported as a placeholder image.`;
    _warn(ctx.report, ctx.slideIndex, warnCode, warnMsg);
    ctx.report.placeholders[counterKey] += 1;

    return {
      id: _makePptxLayerId(),
      type: 'image',
      name: detail,
      target: 'canvas',
      src: PPTX_IMAGE_PLACEHOLDER_URL,
      x: bounds.x,
      y: bounds.y,
      w: bounds.w,
      h: bounds.h,
      rotate: bounds.rotate || 0,
      opacity: 1,
      z: ctx.nextZ++,
    };
  }

  // ---- Shape conversion -----------------------------------------------
  // Per-import counter so two consecutive imports don't generate
  // colliding layer ids. Reset at the start of importPptxFile.
  let _layerIdCounter = 0;
  function _makePptxLayerId() {
    _layerIdCounter += 1;
    return 'pptx-' + Date.now().toString(36) + '-' + _layerIdCounter;
  }

  // Returns an Artstr text layer for a p:sp that carries a p:txBody.
  // Phase 2 emits one text layer per shape; the dominant run's style
  // (font size, color, bold, italic, family) is applied to the whole
  // box. Per-run rich text spans are a Phase 7 enhancement.
  function convertTextShape(spNode, ctx) {
    const txBody = _directChild(spNode, 'txBody');
    if (!txBody) return null;

    const spPr = _directChild(spNode, 'spPr');
    const xfrm = spPr ? _directChild(spPr, 'xfrm') : null;
    const bounds = xfrm ? readXfrm(xfrm, ctx.scale, ctx.groupXfrm) : null;
    // A text shape without explicit xfrm usually inherits from a
    // placeholder on the layout/master. We don't resolve placeholders
    // until Phase 6 — flag and skip so we don't drop a 0x0 layer at
    // (0, 0).
    if (!bounds || bounds.w <= 0 || bounds.h <= 0) {
      _warn(ctx.report, ctx.slideIndex, 'TEXT_STYLE_APPROXIMATED',
        `Slide ${ctx.slideIndex + 1}: text shape inherits geometry from its layout — skipped in Phase 2.`);
      return null;
    }

    const body = _readTxBody(txBody, ctx.theme);
    if (!body) return null; // empty placeholder text

    const style = body.dominantStyle;
    const cNvPr = spNode.getElementsByTagName('p:cNvPr')[0]
              || spNode.getElementsByTagNameNS('*', 'cNvPr')[0];
    const sourceName = cNvPr?.getAttribute('name') || '';
    const label = body.previewText || 'Text';
    const name = sourceName ? `Text (${sourceName}): ${label}` : `Text: ${label}`;

    return {
      id: _makePptxLayerId(),
      type: 'text',
      name,
      target: 'canvas',
      html: body.html,
      x: bounds.x,
      y: bounds.y,
      w: bounds.w,
      h: bounds.h,
      rotate: bounds.rotate || 0,
      opacity: 1,
      z: ctx.nextZ++,
      fontFamily: style.fontFamily || 'inherit',
      fontSize: style.fontSize || 18,
      color: style.color || '#111827',
      align: body.align,
      bold: !!style.bold,
      italic: !!style.italic,
    };
  }

  // Returns an Artstr shape layer for a p:sp with a:prstGeom, or null
  // if the shape should be skipped (text-bodied — handled by
  // convertTextShape). Unknown preset names fall back to a rectangle
  // with a warning.
  function convertPresetShape(spNode, ctx) {
    const txBody = _directChild(spNode, 'txBody');
    if (txBody) return null;

    const spPr = _directChild(spNode, 'spPr');
    if (!spPr) return null;
    const xfrm = _directChild(spPr, 'xfrm');
    const prstGeom = _directChild(spPr, 'prstGeom');
    if (!xfrm || !prstGeom) return null;

    const bounds = readXfrm(xfrm, ctx.scale, ctx.groupXfrm);
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

    // PPTX lines and straight connectors go corner-to-corner of their
    // bounding box; flipH / flipV choose which diagonal. The default
    // line-shape template ships as a horizontal segment, which looks
    // right for thin horizontal bounds but flat for diagonals — fix by
    // honouring the flips here.
    if (shape.kind === 'line') {
      const flipH = xfrm.getAttribute('flipH') === '1';
      const flipV = xfrm.getAttribute('flipV') === '1';
      // Base diagonal: top-left → bottom-right.
      let x1 = 0, y1 = 0, x2 = 100, y2 = 100;
      if (flipH) { x1 = 100; x2 = 0; }
      if (flipV) { y1 = (y1 === 0 ? 100 : 0); y2 = (y2 === 0 ? 100 : 0); }
      shape.x1 = x1; shape.y1 = y1; shape.x2 = x2; shape.y2 = y2;
    }

    // Name the layer with PowerPoint's <p:cNvPr name="..."> if present so
    // the user can match it back to the source deck in the layer panel.
    const cNvPr = spNode.getElementsByTagName('p:cNvPr')[0]
              || spNode.getElementsByTagNameNS('*', 'cNvPr')[0];
    const sourceName = cNvPr?.getAttribute('name') || '';
    const name = sourceName ? `${label || 'Shape'} (${sourceName})` : (label || 'Shape');

    const fill = readFill(spPr, ctx.theme) || { type: 'none' };
    const stroke = readStroke(spPr, ctx.scale, ctx.theme) || { type: 'none', color: '#000000', width: 1, dash: 'solid' };

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
      const ln = child.localName;
      if (ln === 'sp') {
        // A p:sp with p:txBody is a text shape; without it, it's a
        // pure shape. Dispatch to the right converter and bump the
        // matching counter.
        const hasText = !!_directChild(child, 'txBody');
        if (hasText) {
          const layer = convertTextShape(child, ctx);
          if (layer) {
            layersOut.push(layer);
            ctx.report.imported.text += 1;
          }
        } else {
          const layer = convertPresetShape(child, ctx);
          if (layer) {
            layersOut.push(layer);
            ctx.report.imported.shapes += 1;
          }
        }
      } else if (ln === 'pic') {
        const layer = convertPicture(child, ctx);
        if (layer) {
          layersOut.push(layer);
          ctx.report.imported.images += 1;
        }
      } else if (ln === 'graphicFrame') {
        const layer = convertGraphicFrame(child, ctx);
        if (layer) {
          layersOut.push(layer);
          // graphicFrame counters live under report.placeholders.*;
          // convertGraphicFrame increments the appropriate one itself.
        }
      } else if (ln === 'grpSp') {
        // Flatten groups by recursing with a composed transform. The
        // group node itself isn't an Artstr layer — its children
        // become normal top-level layers with their geometry
        // transformed into slide space.
        const grpSpPr = _directChild(child, 'grpSpPr');
        const groupXfrm = grpSpPr ? _directChild(grpSpPr, 'xfrm') : null;
        const prevGroup = ctx.groupXfrm;
        ctx.groupXfrm = enterGroup(prevGroup || IDENTITY_GROUP_XFRM, groupXfrm);
        ctx.report.imported.groups += 1;
        walkSpTree(child, ctx, layersOut);
        ctx.groupXfrm = prevGroup;
      }
    }
  }

  // Read the speaker notes for a given slide. The notes-slide
  // relationship is in ppt/slides/_rels/slideN.xml.rels; we follow it,
  // walk every text shape on the notes slide, and concatenate the
  // plain text into a single string for slide.notes.
  function readSlideNotes(files, slidePath, slideIndex, report) {
    if (!slidePath) return '';
    // Construct the rels path: ppt/slides/slide1.xml → ppt/slides/_rels/slide1.xml.rels
    const m = slidePath.match(/^(.*\/)([^/]+)$/);
    if (!m) return '';
    const relsPath = `${m[1]}_rels/${m[2]}.rels`;
    const relsText = readZipText(files, relsPath);
    if (!relsText) return '';
    let relsDoc;
    try { relsDoc = parseXml(relsText); }
    catch { return ''; }
    const rels = relsDoc.getElementsByTagName('Relationship');
    let notesTarget = '';
    for (let i = 0; i < rels.length; i++) {
      const type = rels[i].getAttribute('Type') || '';
      if (type.endsWith('/notesSlide')) {
        notesTarget = rels[i].getAttribute('Target') || '';
        break;
      }
    }
    if (!notesTarget) return '';
    const notesPath = pptxTargetToZipPath(slidePath, notesTarget);
    const notesText = readZipText(files, notesPath);
    if (!notesText) return '';
    let notesDoc;
    try { notesDoc = parseXml(notesText); }
    catch (err) {
      _warn(report, slideIndex, 'NOTES_PARSE_FAILED',
        `Slide ${slideIndex + 1}: notes XML could not be parsed.`);
      return '';
    }
    const spTree = notesDoc.getElementsByTagName('p:spTree')[0]
               || notesDoc.getElementsByTagNameNS('*', 'spTree')[0];
    if (!spTree) return '';
    const chunks = [];
    for (let i = 0; i < spTree.children.length; i++) {
      const sp = spTree.children[i];
      if (sp.localName !== 'sp') continue;
      const txBody = _directChild(sp, 'txBody');
      if (!txBody) continue;
      // Walk paragraphs and join with line breaks.
      const paragraphs = [];
      for (let j = 0; j < txBody.children.length; j++) {
        const p = txBody.children[j];
        if (p.localName !== 'p') continue;
        const { text } = _readParagraphRuns(p);
        if (text) paragraphs.push(text);
      }
      const joined = paragraphs.join('\n').trim();
      // The notes slide also has a "slide image" placeholder shape that
      // PowerPoint stamps with the slide number ("1", "2", …). Skip
      // single-token numeric chunks so the imported notes don't get a
      // stray slide number prepended.
      if (joined && !/^\d+$/.test(joined)) chunks.push(joined);
    }
    return chunks.join('\n\n');
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

    // The theme cache is keyed by zip path, which is per-package — clear
    // it between imports so a re-import of a different .pptx doesn't
    // reuse a stale entry under the same path.
    _themeCache.clear();

    const files = await readPptxPackage(file);
    const presentation = readPresentationInfo(files, report);
    // EMU → Artstr layer inches. Layer x/y/w/h and stroke width all live
    // in inches (the engine derives canvas dimensions via slide.width / 96).
    const scale = {
      x: TARGET_W_IN / presentation.slideSize.cx,
      y: TARGET_H_IN / presentation.slideSize.cy,
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
      // Resolve the theme + layout / master paths for this slide once;
      // every converter and the background reader use them.
      const theme = loadThemeForSlide(files, slidePath);
      const layoutPath = theme?.layoutPath || '';
      const masterPath = theme?.masterPath || '';

      if (slideText) {
        try {
          const slideDoc = parseXml(slideText);
          const bg = readSlideBackground(slideDoc, i, report, theme, files, layoutPath, masterPath);
          if (bg) {
            background = bg;
            report.imported.backgrounds += 1;
          }
          // Walk the shape tree and convert each p:sp / p:pic /
          // p:graphicFrame / p:grpSp. Theme + group transform are
          // threaded through ctx.
          const spTree = slideDoc.getElementsByTagName('p:spTree')[0]
                     || slideDoc.getElementsByTagNameNS('*', 'spTree')[0];
          const slideRels = readSlideRels(files, slidePath);
          const ctx = {
            scale,
            slideIndex: i,
            report,
            nextZ: 0,
            slideRels,
            groupXfrm: IDENTITY_GROUP_XFRM,
            theme,
          };
          walkSpTree(spTree, ctx, layers);
        } catch (err) {
          _warn(report, i, 'SLIDE_PARSE_FAILED',
            `Slide ${i + 1}: could not parse slide XML — left blank.`);
        }
      }

      // Speaker notes: follow the per-slide notesSlide relationship and
      // extract the plain text. Empty string when the deck doesn't have
      // notes for this slide (most decks won't).
      let notes = '';
      try {
        notes = readSlideNotes(files, slidePath, i, report);
        if (notes) report.imported.notes += 1;
      } catch (err) {
        _warn(report, i, 'NOTES_PARSE_FAILED',
          `Slide ${i + 1}: speaker notes could not be read.`);
      }

      slides.push({
        name: 'Slide ' + (i + 1),
        slide: {
          width: TARGET_W,
          height: TARGET_H,
          background,
          notes,
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
      enterGroup,
      IDENTITY_GROUP_XFRM,
      loadThemeForSlide,
      _applyColorModifiers,
      convertPresetShape,
      convertTextShape,
      convertPicture,
      convertGraphicFrame,
      walkSpTree,
      readSlideRels,
      readSlideNotes,
    },
  };
})();
