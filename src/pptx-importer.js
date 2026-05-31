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
  const _LINE_DEFAULTS = { kind: 'line', x1: 0, y1: 50, x2: 100, y2: 50, strokeWidth: 6 };
  const PPTX_PRST_TO_ARTSTR = {
    rect: { kind: 'rect' },
    roundRect: { kind: 'rounded-rect', cornerRadius: 12 },
    ellipse: { kind: 'ellipse' },
    triangle: { kind: 'triangle' },
    line: { ..._LINE_DEFAULTS },
    straightConnector1: { ..._LINE_DEFAULTS },
    // Bent + curved connectors are approximated as straight lines for
    // now; the per-segment joints / curve handles need a:gd guide
    // resolution which is a future enhancement. The convertPresetShape
    // path emits an UNSUPPORTED_CONNECTOR_APPROXIMATED warning when it
    // hits one of these.
    bentConnector2: { ..._LINE_DEFAULTS },
    bentConnector3: { ..._LINE_DEFAULTS },
    bentConnector4: { ..._LINE_DEFAULTS },
    bentConnector5: { ..._LINE_DEFAULTS },
    curvedConnector2: { ..._LINE_DEFAULTS },
    curvedConnector3: { ..._LINE_DEFAULTS },
    curvedConnector4: { ..._LINE_DEFAULTS },
    curvedConnector5: { ..._LINE_DEFAULTS },
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
    bentConnector2: 'Bent connector',
    bentConnector3: 'Bent connector',
    bentConnector4: 'Bent connector',
    bentConnector5: 'Bent connector',
    curvedConnector2: 'Curved connector',
    curvedConnector3: 'Curved connector',
    curvedConnector4: 'Curved connector',
    curvedConnector5: 'Curved connector',
    star5: 'Star',
    hexagon: 'Hexagon',
    pentagon: 'Pentagon',
  };
  // Presets we approximate as a single straight line — warn the user so
  // they know the imported shape is a placeholder for richer geometry.
  const APPROXIMATED_AS_LINE = new Set([
    'bentConnector2', 'bentConnector3', 'bentConnector4', 'bentConnector5',
    'curvedConnector2', 'curvedConnector3', 'curvedConnector4', 'curvedConnector5',
  ]);

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

  // Walk a:r (run), a:fld (field), and a:br (line break) children of a
  // paragraph and return an ordered list of { text, style } entries.
  // a:br becomes a run with text '\n' and a null style so the HTML
  // builder can emit a <br> without wrapping it. style is null when
  // a run has no a:rPr — the renderer will fall back to layer defaults
  // for those runs.
  //
  // Callers that only need plain text concatenate `.text` across the
  // returned runs (used by the notes-slide reader).
  function _readParagraphRuns(pNode, theme) {
    const runs = [];
    for (let i = 0; i < pNode.children.length; i++) {
      const child = pNode.children[i];
      const ln = child.localName;
      if (ln === 'r' || ln === 'fld') {
        const t = child.getElementsByTagName('a:t')[0]
              || child.getElementsByTagNameNS('*', 't')[0];
        const text = t ? (t.textContent || '') : '';
        if (!text) continue;
        const rPr = _directChild(child, 'rPr');
        const style = rPr ? _readRunStyle(rPr, theme) : null;
        runs.push({ text, style });
      } else if (ln === 'br') {
        runs.push({ text: '\n', style: null });
      }
    }
    return runs;
  }

  // Plain text from a list of runs. Used by the notes-slide reader,
  // which doesn't care about per-run styling.
  function _runsToPlainText(runs) {
    let s = '';
    for (const r of runs) s += r.text;
    return s;
  }

  // Render a single run into HTML, wrapping with <b>/<i>/<span> only
  // for fields that differ from the dominant (layer-level) style. The
  // layer's defaults already handle anything matching dominant, so we
  // emit the minimum markup needed for fidelity.
  //
  // dominant is normalised to {} when no run had explicit style.
  function _runToHtml(run, dominant) {
    let body = _escapeHtml(run.text).replace(/\n/g, '<br>');
    if (!run.style) return body; // inherit layer defaults
    const s = run.style;
    const d = dominant || {};
    // Build the inline-style fragment for font-size / color / family
    // overrides.
    const styleParts = [];
    if (s.fontSize != null && s.fontSize !== d.fontSize) {
      styleParts.push(`font-size:${s.fontSize}pt`);
    }
    if (s.color && s.color !== d.color) {
      styleParts.push(`color:${s.color}`);
    }
    if (s.fontFamily && s.fontFamily !== d.fontFamily) {
      // PPTX font names can contain spaces; quote with HTML entities
      // so the inner quotes don't terminate the style="..." attribute.
      const safe = s.fontFamily.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      styleParts.push(`font-family:&quot;${safe}&quot;`);
    }
    // Wrapping order: <span style> goes innermost, then <i>, then <b>
    // outermost. b/i are categorical state; the inline style is the
    // fine-grained override.
    if (styleParts.length) {
      body = `<span style="${styleParts.join(';')}">${body}</span>`;
    }
    // Italic delta. The reverse case (dominant italic, run not) gets
    // an explicit font-style:normal span.
    if (s.italic && !d.italic) body = `<i>${body}</i>`;
    else if (!s.italic && d.italic && run.style) {
      body = `<span style="font-style:normal">${body}</span>`;
    }
    // Bold delta — same shape as italic.
    if (s.bold && !d.bold) body = `<b>${body}</b>`;
    else if (!s.bold && d.bold && run.style) {
      body = `<span style="font-weight:normal">${body}</span>`;
    }
    return body;
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

  // Read p:txBody → Artstr text layer's html + dominant style. The
  // first run with an explicit a:rPr becomes the layer-level dominant;
  // subsequent runs that disagree get wrapped in inline <b>/<i>/<span>
  // so mid-paragraph styling survives the round-trip.
  function _readTxBody(txBodyNode, theme) {
    if (!txBodyNode) return null;
    // Walk every paragraph up front so we can pick the dominant style
    // before emitting any HTML.
    const paragraphs = [];
    let alignFromFirstP = null;
    for (let i = 0; i < txBodyNode.children.length; i++) {
      const p = txBodyNode.children[i];
      if (p.localName !== 'p') continue;
      const runs = _readParagraphRuns(p, theme);
      const pPr = _directChild(p, 'pPr');
      const algn = pPr?.getAttribute('algn');
      const align = (algn && PPTX_ALIGN_TO_ARTSTR[algn]) ? PPTX_ALIGN_TO_ARTSTR[algn] : null;
      if (alignFromFirstP === null && align) alignFromFirstP = align;
      paragraphs.push({ runs });
    }

    // Dominant style = first run anywhere in the body with an explicit
    // rPr. Falls back to {} if every run inherits defaults.
    let dominantStyle = null;
    for (const p of paragraphs) {
      for (const r of p.runs) {
        if (r.style) { dominantStyle = r.style; break; }
      }
      if (dominantStyle) break;
    }
    dominantStyle = dominantStyle || {};

    // Emit HTML: each paragraph's runs joined contiguously, paragraphs
    // joined with <br>. Plain-text preview pulled in parallel for the
    // layer's name field.
    const paragraphHtmls = [];
    let plainText = '';
    for (const p of paragraphs) {
      const segments = [];
      for (const r of p.runs) {
        segments.push(_runToHtml(r, dominantStyle));
        plainText += r.text;
      }
      paragraphHtmls.push(segments.join(''));
      plainText += '\n';
    }
    plainText = plainText.trim();
    if (!plainText) return null;
    const html = paragraphHtmls.join('<br>');
    return {
      html,
      align: alignFromFirstP || 'left',
      dominantStyle,
      previewText: plainText.slice(0, 60),
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

  // ---- Native chart import (CHART_IMPORT_FEATURE.md Phase 1) ----------
  // Default Office accent palette — fallback for c:ser entries that
  // don't carry an explicit c:spPr/a:solidFill. Matches the colours
  // PowerPoint applies in series-index order.
  const CHART_DEFAULT_PALETTE = [
    '#4472C4', '#ED7D31', '#A5A5A5', '#FFC000',
    '#5B9BD5', '#70AD47',
  ];

  // Pull category labels out of c:cat. PPTX wraps these in either a
  // single-level c:strRef (flat list) or a c:multiLvlStrRef (nested
  // when categories span multiple hierarchy levels — we collapse to
  // the deepest level). Returns string[].
  function readCategoryLabels(catNode) {
    if (!catNode) return [];
    const out = [];
    const single = _directChild(catNode, 'strRef');
    const multi = _directChild(catNode, 'multiLvlStrRef');
    const cache = (single && _directChild(single, 'strCache'))
              || (multi  && _directChild(multi,  'multiLvlStrCache'));
    if (!cache) return [];
    // multiLvlStrCache nests a:lvl children; strCache has c:pt directly.
    // Either way we want the c:pt > c:v values.
    const lvls = [];
    for (let i = 0; i < cache.children.length; i++) {
      if (cache.children[i].localName === 'lvl') lvls.push(cache.children[i]);
    }
    const ptHost = lvls.length ? lvls[0] : cache;
    for (let i = 0; i < ptHost.children.length; i++) {
      const pt = ptHost.children[i];
      if (pt.localName !== 'pt') continue;
      const idx = Number(pt.getAttribute('idx')) || 0;
      const v = _directChild(pt, 'v');
      out[idx] = v ? (v.textContent || '') : '';
    }
    // Fill any sparse gaps with empty strings so the index space is
    // contiguous for the bar-layout math.
    for (let i = 0; i < out.length; i++) if (out[i] == null) out[i] = '';
    return out;
  }

  // Pull numeric values out of c:val/c:numRef/c:numCache. Returns number[].
  function readSeriesValues(valNode) {
    if (!valNode) return [];
    const ref = _directChild(valNode, 'numRef');
    const cache = ref ? _directChild(ref, 'numCache') : null;
    if (!cache) return [];
    const out = [];
    for (let i = 0; i < cache.children.length; i++) {
      const pt = cache.children[i];
      if (pt.localName !== 'pt') continue;
      const idx = Number(pt.getAttribute('idx')) || 0;
      const v = _directChild(pt, 'v');
      out[idx] = v ? Number(v.textContent) || 0 : 0;
    }
    for (let i = 0; i < out.length; i++) if (out[i] == null) out[i] = 0;
    return out;
  }

  // Pull the series display name out of c:tx/c:strRef/c:strCache (or
  // c:tx/c:v for the rare inline case). Returns string or ''.
  function readSeriesName(txNode) {
    if (!txNode) return '';
    const ref = _directChild(txNode, 'strRef');
    if (ref) {
      const cache = _directChild(ref, 'strCache');
      if (cache) {
        for (let i = 0; i < cache.children.length; i++) {
          const pt = cache.children[i];
          if (pt.localName === 'pt') {
            const v = _directChild(pt, 'v');
            if (v) return v.textContent || '';
          }
        }
      }
    }
    const inlineV = _directChild(txNode, 'v');
    return inlineV ? (inlineV.textContent || '') : '';
  }

  // Resolve the fill colour for a c:ser. Series colour priority:
  //   1. c:ser/c:spPr/a:solidFill (srgbClr or schemeClr+theme).
  //   2. Office default palette indexed by series order.
  function readSeriesColor(serNode, theme, fallbackIdx) {
    const spPr = _directChild(serNode, 'spPr');
    if (spPr) {
      const solid = _directChild(spPr, 'solidFill');
      if (solid) {
        const c = convertColor(solid, theme);
        if (c) return c;
      }
    }
    return CHART_DEFAULT_PALETTE[fallbackIdx % CHART_DEFAULT_PALETTE.length];
  }

  // Build an array of Artstr shape + text layers for a clustered
  // c:barChart (col or bar direction). Returns null when the chart
  // is empty (no series, no values, etc.) so the caller can fall
  // through to the placeholder behaviour.
  function buildBarChartLayers(barChartNode, gfBounds, chartLabel, ctx) {
    const dirNode = _directChild(barChartNode, 'barDir');
    const direction = dirNode?.getAttribute('val') || 'col'; // 'col' or 'bar'
    const grouping = _directChild(barChartNode, 'grouping')?.getAttribute('val') || 'clustered';
    // Phase 1: clustered only. Stacked variants emit a warning and
    // fall back to placeholder (caller handles).
    if (grouping !== 'clustered' && grouping !== 'standard') return null;

    // Collect series in document order; PPTX guarantees they're in
    // visual order so we don't need to sort by c:order.
    const serNodes = [];
    for (let i = 0; i < barChartNode.children.length; i++) {
      if (barChartNode.children[i].localName === 'ser') serNodes.push(barChartNode.children[i]);
    }
    if (!serNodes.length) return null;

    let categories = [];
    const series = [];
    for (let i = 0; i < serNodes.length; i++) {
      const s = serNodes[i];
      const cat = _directChild(s, 'cat');
      // Categories are usually duplicated across series; first one wins.
      if (!categories.length && cat) categories = readCategoryLabels(cat);
      const valNode = _directChild(s, 'val');
      const values = readSeriesValues(valNode);
      const name = readSeriesName(_directChild(s, 'tx'));
      const color = readSeriesColor(s, ctx.theme, i);
      series.push({ name, color, values });
    }
    if (!series.length) return null;

    const N = categories.length || series[0].values.length;
    if (!N) return null;
    const S = series.length;

    // Plot area: fixed inset for now (manualLayout is Phase 4 polish).
    const pa = {
      x: gfBounds.x + gfBounds.w * 0.05,
      y: gfBounds.y + gfBounds.h * 0.05,
      w: gfBounds.w * 0.90,
      h: gfBounds.h * 0.80, // leaves 15% gap at the bottom for category labels
    };

    // Auto-scale to data max. Negative values aren't handled in Phase 1.
    let maxV = 0;
    for (const s of series) {
      for (const v of s.values) if (v > maxV) maxV = v;
    }
    if (maxV <= 0) maxV = 1;

    const layers = [];

    // ---- Bars ----
    if (direction === 'col') {
      // Vertical columns: categories along X, value extends up.
      const catW = pa.w / N;
      const gap  = catW * 0.15;       // ~15 % gap between category groups
      const barW = (catW - gap) / S;
      for (let c = 0; c < N; c++) {
        for (let si = 0; si < S; si++) {
          const v = series[si].values[c] || 0;
          if (v <= 0) continue;
          const hBar = pa.h * (v / maxV);
          const xBar = pa.x + c * catW + gap / 2 + si * barW;
          const yBar = pa.y + pa.h - hBar;
          layers.push({
            id: _makePptxLayerId(),
            type: 'shape',
            name: `${chartLabel} / Bar [${categories[c] || c + 1}, ${series[si].name || `Series ${si + 1}`}]`,
            target: 'canvas',
            x: xBar, y: yBar, w: barW, h: hBar,
            rotate: 0, opacity: 1, z: ctx.nextZ++,
            shape: { kind: 'rect' },
            fill: { type: 'solid', color: series[si].color },
            stroke: { type: 'none', color: '#000000', width: 1, dash: 'solid' },
          });
        }
      }
    } else {
      // Horizontal bars: categories along Y, value extends right.
      const catH = pa.h / N;
      const gap  = catH * 0.15;
      const barH = (catH - gap) / S;
      for (let c = 0; c < N; c++) {
        for (let si = 0; si < S; si++) {
          const v = series[si].values[c] || 0;
          if (v <= 0) continue;
          const wBar = pa.w * (v / maxV);
          const xBar = pa.x;
          const yBar = pa.y + c * catH + gap / 2 + si * barH;
          layers.push({
            id: _makePptxLayerId(),
            type: 'shape',
            name: `${chartLabel} / Bar [${categories[c] || c + 1}, ${series[si].name || `Series ${si + 1}`}]`,
            target: 'canvas',
            x: xBar, y: yBar, w: wBar, h: barH,
            rotate: 0, opacity: 1, z: ctx.nextZ++,
            shape: { kind: 'rect' },
            fill: { type: 'solid', color: series[si].color },
            stroke: { type: 'none', color: '#000000', width: 1, dash: 'solid' },
          });
        }
      }
    }

    // ---- Category labels ----
    // Below the plot area for column charts; to the left for bar charts.
    if (direction === 'col') {
      const labelW = pa.w / N;
      const labelH = gfBounds.h * 0.10;
      for (let c = 0; c < N; c++) {
        const label = categories[c] || '';
        if (!label) continue;
        layers.push({
          id: _makePptxLayerId(),
          type: 'text',
          name: `${chartLabel} / Category label: ${label}`,
          target: 'canvas',
          html: _escapeHtml(label),
          x: pa.x + c * labelW,
          y: pa.y + pa.h + (gfBounds.h * 0.02),
          w: labelW, h: labelH,
          rotate: 0, opacity: 1, z: ctx.nextZ++,
          fontFamily: 'inherit',
          fontSize: 12,
          color: '#333333',
          align: 'center',
          bold: false, italic: false,
        });
      }
    } else {
      const labelH = pa.h / N;
      const labelW = gfBounds.w * 0.12;
      for (let c = 0; c < N; c++) {
        const label = categories[c] || '';
        if (!label) continue;
        layers.push({
          id: _makePptxLayerId(),
          type: 'text',
          name: `${chartLabel} / Category label: ${label}`,
          target: 'canvas',
          html: _escapeHtml(label),
          x: pa.x - labelW - (gfBounds.w * 0.01),
          y: pa.y + c * labelH,
          w: labelW, h: labelH,
          rotate: 0, opacity: 1, z: ctx.nextZ++,
          fontFamily: 'inherit',
          fontSize: 12,
          color: '#333333',
          align: 'right',
          bold: false, italic: false,
        });
      }
    }

    return layers;
  }

  // Build an SVG path-d string for a single pie / doughnut slice in
  // a 100x100 coord system centred at (50, 50). Angles are in
  // radians; positive sweep direction is clockwise on screen (SVG's
  // +y is down, so increasing angle = visually clockwise).  innerR
  // > 0 produces a doughnut ring sector.
  function _sliceArcPath(cx, cy, outerR, startAngle, endAngle, innerR) {
    const sweep = endAngle - startAngle;
    if (sweep <= 0) return '';
    const TAU = Math.PI * 2;
    // Full circle: emit two half-arcs so SVG can render it.
    if (sweep >= TAU - 1e-6) {
      const right = cx + outerR;
      if (innerR > 0) {
        const innerRight = cx + innerR;
        return `M ${right} ${cy} A ${outerR} ${outerR} 0 1 1 ${cx - outerR} ${cy} A ${outerR} ${outerR} 0 1 1 ${right} ${cy} Z M ${innerRight} ${cy} A ${innerR} ${innerR} 0 1 0 ${cx - innerR} ${cy} A ${innerR} ${innerR} 0 1 0 ${innerRight} ${cy} Z`;
      }
      return `M ${right} ${cy} A ${outerR} ${outerR} 0 1 1 ${cx - outerR} ${cy} A ${outerR} ${outerR} 0 1 1 ${right} ${cy} Z`;
    }
    const large = sweep > Math.PI ? 1 : 0;
    const x1 = cx + outerR * Math.cos(startAngle);
    const y1 = cy + outerR * Math.sin(startAngle);
    const x2 = cx + outerR * Math.cos(endAngle);
    const y2 = cy + outerR * Math.sin(endAngle);
    if (innerR > 0) {
      const ix1 = cx + innerR * Math.cos(startAngle);
      const iy1 = cy + innerR * Math.sin(startAngle);
      const ix2 = cx + innerR * Math.cos(endAngle);
      const iy2 = cy + innerR * Math.sin(endAngle);
      // Outer arc forward, line in, inner arc back, line out.
      return `M ${x1} ${y1} A ${outerR} ${outerR} 0 ${large} 1 ${x2} ${y2} L ${ix2} ${iy2} A ${innerR} ${innerR} 0 ${large} 0 ${ix1} ${iy1} Z`;
    }
    return `M ${cx} ${cy} L ${x1} ${y1} A ${outerR} ${outerR} 0 ${large} 1 ${x2} ${y2} Z`;
  }

  // Pick the per-slice fill colour for a pie / doughnut. PPTX
  // priority:
  //   1. c:ser/c:dPt[@idx=sliceIdx]/c:spPr/a:solidFill — explicit
  //      per-slice override (the common case in templated decks).
  //   2. c:varyColors val="1" (the pie default) — palette rotation
  //      indexed by sliceIdx.
  //   3. c:ser/c:spPr/a:solidFill — uniform-colour pie.
  //   4. CHART_DEFAULT_PALETTE indexed by sliceIdx as final fallback.
  function _readPieSliceColor(serNode, sliceIdx, varyColors, theme) {
    for (let i = 0; i < serNode.children.length; i++) {
      const ch = serNode.children[i];
      if (ch.localName !== 'dPt') continue;
      const idxN = _directChild(ch, 'idx');
      if (!idxN || Number(idxN.getAttribute('val')) !== sliceIdx) continue;
      const spPr = _directChild(ch, 'spPr');
      if (!spPr) continue;
      const solid = _directChild(spPr, 'solidFill');
      if (solid) {
        const c = convertColor(solid, theme);
        if (c) return c;
      }
    }
    if (varyColors) {
      return CHART_DEFAULT_PALETTE[sliceIdx % CHART_DEFAULT_PALETTE.length];
    }
    const spPr = _directChild(serNode, 'spPr');
    if (spPr) {
      const solid = _directChild(spPr, 'solidFill');
      if (solid) {
        const c = convertColor(solid, theme);
        if (c) return c;
      }
    }
    return CHART_DEFAULT_PALETTE[sliceIdx % CHART_DEFAULT_PALETTE.length];
  }

  // c:pieChart / c:doughnutChart → an array of path-shape layers,
  // one per slice. All slices share a common square sub-bounds
  // centred in the chart's graphicFrame area so the pie renders
  // circular even when the chart's overall bounds are rectangular.
  function buildPieChartLayers(pieChartNode, gfBounds, chartLabel, ctx, opts) {
    const isDoughnut = !!(opts && opts.isDoughnut);
    const varyColorsNode = _directChild(pieChartNode, 'varyColors');
    const varyColors = varyColorsNode
      ? (varyColorsNode.getAttribute('val') !== '0')
      : true; // default for pie / doughnut

    const serNode = _directChild(pieChartNode, 'ser');
    if (!serNode) return null;

    const values = readSeriesValues(_directChild(serNode, 'val'));
    const categories = readCategoryLabels(_directChild(serNode, 'cat'));
    let total = 0;
    for (const v of values) total += Math.max(0, Number(v) || 0);
    if (total <= 0) return null;

    let holePct = 50;
    if (isDoughnut) {
      const hsNode = _directChild(pieChartNode, 'holeSize');
      const v = Number(hsNode?.getAttribute('val'));
      if (Number.isFinite(v) && v > 0) holePct = Math.max(10, Math.min(90, v));
    }

    let firstAngleDeg = 0;
    const fsNode = _directChild(pieChartNode, 'firstSliceAng');
    const fsv = Number(fsNode?.getAttribute('val'));
    if (Number.isFinite(fsv)) firstAngleDeg = fsv;

    const side = Math.min(gfBounds.w, gfBounds.h);
    const sliceBounds = {
      x: gfBounds.x + (gfBounds.w - side) / 2,
      y: gfBounds.y + (gfBounds.h - side) / 2,
      w: side,
      h: side,
    };

    const cx = 50, cy = 50;
    const outerR = 45;
    const innerR = isDoughnut ? outerR * (holePct / 100) : 0;
    let angle = -Math.PI / 2 + (firstAngleDeg * Math.PI / 180);

    const layers = [];
    for (let i = 0; i < values.length; i++) {
      const v = Math.max(0, Number(values[i]) || 0);
      if (v <= 0) continue;
      const sweep = (Math.PI * 2) * (v / total);
      const d = _sliceArcPath(cx, cy, outerR, angle, angle + sweep, innerR);
      angle += sweep;
      if (!d) continue;
      const color = _readPieSliceColor(serNode, i, varyColors, ctx.theme);
      const catLabel = categories[i] || `Slice ${i + 1}`;
      layers.push({
        id: _makePptxLayerId(),
        type: 'shape',
        name: `${chartLabel} / Slice [${catLabel}] (${v})`,
        target: 'canvas',
        x: sliceBounds.x,
        y: sliceBounds.y,
        w: sliceBounds.w,
        h: sliceBounds.h,
        rotate: 0,
        opacity: 1,
        z: ctx.nextZ++,
        shape: {
          kind: 'path',
          d,
          viewBox: { x: 0, y: 0, w: 100, h: 100 },
        },
        fill: { type: 'solid', color },
        stroke: { type: 'none', color: '#000000', width: 1, dash: 'solid' },
      });
    }
    return layers.length ? layers : null;
  }

  // Build a polyline-d string in 0..100 × 0..100 viewBox coords. xs and
  // ys arrays are paired; the polyline starts at (xs[0], ys[0]) and
  // line-segments through the rest.
  function _polylinePathD(xs, ys) {
    if (!xs.length) return '';
    if (xs.length === 1) {
      // Single point — emit a tiny dot via a degenerate Move + Line.
      const fmt = (n) => Number(n).toFixed(3);
      return `M ${fmt(xs[0])} ${fmt(ys[0])} L ${fmt(xs[0])} ${fmt(ys[0])}`;
    }
    const fmt = (n) => Number(n).toFixed(3);
    let d = `M ${fmt(xs[0])} ${fmt(ys[0])}`;
    for (let i = 1; i < xs.length; i++) d += ` L ${fmt(xs[i])} ${fmt(ys[i])}`;
    return d;
  }

  // c:lineChart → one path-shape layer per series (polyline) plus
  // optional marker shapes at each data point. Category labels go
  // below the plot area, like the bar / column chart.
  function buildLineChartLayers(lineChartNode, gfBounds, chartLabel, ctx) {
    const serNodes = [];
    for (let i = 0; i < lineChartNode.children.length; i++) {
      if (lineChartNode.children[i].localName === 'ser') serNodes.push(lineChartNode.children[i]);
    }
    if (!serNodes.length) return null;

    let categories = [];
    const series = [];
    for (let i = 0; i < serNodes.length; i++) {
      const s = serNodes[i];
      const cat = _directChild(s, 'cat');
      if (!categories.length && cat) categories = readCategoryLabels(cat);
      const values = readSeriesValues(_directChild(s, 'val'));
      const name = readSeriesName(_directChild(s, 'tx'));

      // Line colour: from c:ser/c:spPr/a:ln/a:solidFill (the line stroke
      // — note this is on a:ln, NOT directly on c:spPr like bar fills).
      let color = null;
      const spPr = _directChild(s, 'spPr');
      const ln = spPr ? _directChild(spPr, 'ln') : null;
      if (ln) {
        const lnFill = _directChild(ln, 'solidFill');
        if (lnFill) color = convertColor(lnFill, ctx.theme);
      }
      if (!color) color = CHART_DEFAULT_PALETTE[i % CHART_DEFAULT_PALETTE.length];

      // Line width: a:ln@w in EMU. PPTX stroke widths are absolute
      // (independent of slide scale), so convert via EMU_PER_IN
      // directly. Fallback to ~2 CSS pixels for series with no
      // explicit width.
      const EMU_PER_IN = 914400;
      let lineWidthIn = 2 / PX_PER_IN;
      if (ln) {
        const wEmu = Number(ln.getAttribute('w')) || 0;
        if (wEmu > 0) lineWidthIn = wEmu / EMU_PER_IN;
      }

      // Marker: c:marker/c:symbol. PowerPoint's default is 'none' for
      // series without an explicit marker; when present, default size
      // is 5pt and default symbol is 'circle'.
      let markerEnabled = false;
      let markerSizeIn = 5 / 72; // 5pt → inches
      let markerColor = color;
      const marker = _directChild(s, 'marker');
      if (marker) {
        const symbolNode = _directChild(marker, 'symbol');
        const symVal = symbolNode?.getAttribute('val') || 'circle';
        markerEnabled = symVal !== 'none';
        const sizeNode = _directChild(marker, 'size');
        if (sizeNode) {
          const v = Number(sizeNode.getAttribute('val'));
          if (Number.isFinite(v) && v > 0) markerSizeIn = v / 72;
        }
        // Marker fill colour: c:marker/c:spPr/a:solidFill overrides
        // the series line colour.
        const mSpPr = _directChild(marker, 'spPr');
        if (mSpPr) {
          const mFill = _directChild(mSpPr, 'solidFill');
          if (mFill) {
            const mc = convertColor(mFill, ctx.theme);
            if (mc) markerColor = mc;
          }
        }
      }

      series.push({ name, color, values, lineWidth: lineWidthIn, markerEnabled, markerSizeIn, markerColor });
    }

    // Plot area (same inset model as bar chart).
    const pa = {
      x: gfBounds.x + gfBounds.w * 0.05,
      y: gfBounds.y + gfBounds.h * 0.05,
      w: gfBounds.w * 0.90,
      h: gfBounds.h * 0.80,
    };

    const N = categories.length || series[0].values.length;
    if (!N) return null;
    let maxV = 0;
    for (const s of series) for (const v of s.values) if (v > maxV) maxV = v;
    if (maxV <= 0) maxV = 1;

    const layers = [];

    // ---- Polylines ----
    for (let si = 0; si < series.length; si++) {
      const s = series[si];
      const xs = [];
      const ys = [];
      // Span the plot area corner-to-corner: first point at x=0, last
      // at x=100 (in viewBox space). When N === 1, both edges collapse.
      for (let c = 0; c < N; c++) {
        const v = Number(s.values[c]) || 0;
        const xt = N > 1 ? (c / (N - 1)) : 0.5;
        xs.push(xt * 100);
        ys.push(100 - (v / maxV) * 100);
      }
      const d = _polylinePathD(xs, ys);
      if (!d) continue;
      // Stroke width in viewBox units. Layer covers pa, so use the
      // uniform-scale formula (stroke.width / pa.w) · 100, then let
      // the renderer's [0.1, 50] clamp catch outliers.
      const vbStrokeWidth = (s.lineWidth / Math.max(pa.w, pa.h)) * 100;

      layers.push({
        id: _makePptxLayerId(),
        type: 'shape',
        name: `${chartLabel} / Line [${s.name || `Series ${si + 1}`}]`,
        target: 'canvas',
        x: pa.x, y: pa.y, w: pa.w, h: pa.h,
        rotate: 0, opacity: 1, z: ctx.nextZ++,
        shape: {
          kind: 'path',
          d,
          viewBox: { x: 0, y: 0, w: 100, h: 100 },
        },
        fill: { type: 'none' },
        stroke: {
          type: 'solid',
          color: s.color,
          width: Math.max(0.1, Math.min(50, vbStrokeWidth)),
          dash: 'solid',
        },
      });

      // ---- Markers ----
      if (s.markerEnabled) {
        for (let c = 0; c < N; c++) {
          const v = Number(s.values[c]) || 0;
          const cxFrac = N > 1 ? (c / (N - 1)) : 0.5;
          const cxIn = pa.x + cxFrac * pa.w;
          const cyIn = pa.y + pa.h - (v / maxV) * pa.h;
          // Centred at the data point, square layer of marker size.
          layers.push({
            id: _makePptxLayerId(),
            type: 'shape',
            name: `${chartLabel} / Marker [${categories[c] || c + 1}, ${s.name || `Series ${si + 1}`}]`,
            target: 'canvas',
            x: cxIn - s.markerSizeIn / 2,
            y: cyIn - s.markerSizeIn / 2,
            w: s.markerSizeIn,
            h: s.markerSizeIn,
            rotate: 0, opacity: 1, z: ctx.nextZ++,
            shape: { kind: 'circle' },
            fill: { type: 'solid', color: s.markerColor },
            stroke: { type: 'none', color: '#000000', width: 1, dash: 'solid' },
          });
        }
      }
    }

    // ---- Category labels (below the plot area) ----
    const labelW = pa.w / N;
    const labelH = gfBounds.h * 0.10;
    for (let c = 0; c < N; c++) {
      const label = categories[c] || '';
      if (!label) continue;
      const cxFrac = N > 1 ? (c / (N - 1)) : 0.5;
      const cxIn = pa.x + cxFrac * pa.w;
      layers.push({
        id: _makePptxLayerId(),
        type: 'text',
        name: `${chartLabel} / Category label: ${label}`,
        target: 'canvas',
        html: _escapeHtml(label),
        x: cxIn - labelW / 2,
        y: pa.y + pa.h + (gfBounds.h * 0.02),
        w: labelW,
        h: labelH,
        rotate: 0, opacity: 1, z: ctx.nextZ++,
        fontFamily: 'inherit',
        fontSize: 12,
        color: '#333333',
        align: 'center',
        bold: false, italic: false,
      });
    }

    return layers.length ? layers : null;
  }

  // Dispatch on the chart type inside c:chartSpace/c:chart/c:plotArea.
  // Returns an array of Artstr layers or null when the chart type
  // isn't natively supported (caller falls back to placeholder).
  function convertChart(chartDoc, gfBounds, chartLabel, ctx) {
    if (!chartDoc) return null;
    const plotArea = chartDoc.getElementsByTagName('c:plotArea')[0]
                  || chartDoc.getElementsByTagNameNS('*', 'plotArea')[0];
    if (!plotArea) return null;
    // First chart-type child wins. Combo charts (multiple chart types
    // in one plot area) are Phase 6.
    for (let i = 0; i < plotArea.children.length; i++) {
      const ch = plotArea.children[i];
      if (ch.localName === 'barChart') {
        return buildBarChartLayers(ch, gfBounds, chartLabel, ctx);
      }
      if (ch.localName === 'pieChart') {
        return buildPieChartLayers(ch, gfBounds, chartLabel, ctx, { isDoughnut: false });
      }
      if (ch.localName === 'doughnutChart') {
        return buildPieChartLayers(ch, gfBounds, chartLabel, ctx, { isDoughnut: true });
      }
      if (ch.localName === 'lineChart') {
        return buildLineChartLayers(ch, gfBounds, chartLabel, ctx);
      }
      // Phase 5: bar3DChart, line3DChart, pie3DChart, etc.
    }
    return null;
  }

  // Resolve the chart's relationship from the slide rels, read the
  // chart XML out of the package, and parse it. Returns the parsed
  // Document or null if anything's missing.
  function _readChartDocFromGraphicFrame(gfNode, ctx) {
    const graphic = _directChild(gfNode, 'graphic');
    const graphicData = graphic ? _directChild(graphic, 'graphicData') : null;
    if (!graphicData) return null;
    let chartRef = null;
    for (let i = 0; i < graphicData.children.length; i++) {
      if (graphicData.children[i].localName === 'chart') { chartRef = graphicData.children[i]; break; }
    }
    if (!chartRef) return null;
    const rId = chartRef.getAttributeNS(RELATIONSHIPS_NS, 'id')
             || chartRef.getAttribute('r:id') || '';
    if (!rId) return null;
    const rel = ctx.slideRels?.get(rId);
    if (!rel) return null;
    const chartPath = pptxTargetToZipPath(ctx.slidePath || 'ppt/slides/x.xml', rel.target);
    const text = readZipText(ctx.files, chartPath);
    if (!text) return null;
    try { return parseXml(text); } catch { return null; }
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

    // Native chart import — try this BEFORE emitting the placeholder.
    // If it returns a layer array we use it; null means the chart type
    // isn't supported yet and we fall through to the placeholder path
    // (existing UNSUPPORTED_CHART_PLACEHOLDER behaviour).
    if (kind === 'chart') {
      const chartDoc = _readChartDocFromGraphicFrame(gfNode, ctx);
      if (chartDoc) {
        const chartLabel = sourceName ? `Chart: ${sourceName}` : 'Chart';
        const chartLayers = convertChart(chartDoc, bounds, chartLabel, ctx);
        if (Array.isArray(chartLayers) && chartLayers.length) {
          // Bump the bucketed counters so the import report reflects
          // shapes + text added natively rather than placing a
          // placeholder.
          for (const layer of chartLayers) {
            if (layer.type === 'shape') ctx.report.imported.shapes += 1;
            else if (layer.type === 'text') ctx.report.imported.text += 1;
          }
          return chartLayers;
        }
        // Recognised file but type not yet supported (Phase 2+).
        _warn(ctx.report, ctx.slideIndex, 'CHART_TYPE_UNSUPPORTED',
          `Slide ${ctx.slideIndex + 1}: chart type not yet natively imported — kept as a placeholder.`);
      }
    }

    const detail = sourceName ? `${label} placeholder: ${sourceName}` : `${label} placeholder`;
    warnMsg = `Slide ${ctx.slideIndex + 1}: ${label.toLowerCase()} was imported as a placeholder image.`;
    _warn(ctx.report, ctx.slideIndex, warnCode, warnMsg);
    ctx.report.placeholders[counterKey] += 1;

    return [{
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
    }];
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
    if (!bounds) return null;

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

    // Zero-area filter: lines are allowed to have cx=0 (vertical) or
    // cy=0 (horizontal) — the bounding box is a degenerate segment but
    // the stroke still renders a visible line. Non-line shapes with
    // zero area are dropped (nothing to render).
    if (shape.kind !== 'line' && (bounds.w <= 0 || bounds.h <= 0)) return null;

    // Read fill + stroke now so the line branch below can use the
    // PPTX a:ln colour + width directly. For non-line shapes these
    // become the layer.fill / layer.stroke fields as-is.
    let fill = readFill(spPr, ctx.theme) || { type: 'none' };
    let stroke = readStroke(spPr, ctx.scale, ctx.theme) || { type: 'none', color: '#000000', width: 1, dash: 'solid' };

    // Lines have three flavours by source extents: horizontal (cy=0),
    // vertical (cx=0), and diagonal (both > 0). The Artstr line
    // renderer has a hard floor of 0.5 viewBox units on stroke-width,
    // which on a 5"-wide line bottoms out at ~2.5px — way too thick
    // for a hairline. Workaround: render straight horizontal /
    // vertical lines as a thin filled `rect` with bounds.h (or w)
    // equal to the source a:ln@w. That gives pixel-perfect thickness
    // and bypasses the line renderer's floor entirely. Diagonal lines
    // keep `kind: 'line'` because they can't be represented as an
    // axis-aligned rect.
    if (shape.kind === 'line') {
      const flipH = xfrm.getAttribute('flipH') === '1';
      const flipV = xfrm.getAttribute('flipV') === '1';
      const extNode = _directChild(xfrm, 'ext');
      const srcCx = Number(extNode?.getAttribute('cx')) || 0;
      const srcCy = Number(extNode?.getAttribute('cy')) || 0;
      const isHorizontal = srcCy === 0 && srcCx > 0;
      const isVertical = srcCx === 0 && srcCy > 0;
      const strokeColor = (stroke?.type === 'solid' && stroke.color) ? stroke.color : '#000000';
      const strokeWidthIn = (stroke?.type === 'solid' && stroke.width > 0)
        ? stroke.width
        : 1 / PX_PER_IN;

      if (isHorizontal || isVertical) {
        // Switch representation: thin filled rectangle.
        shape = { kind: 'rect' };
        fill = { type: 'solid', color: strokeColor };
        stroke = { type: 'none', color: '#000000', width: 1, dash: 'solid' };
        if (isHorizontal) {
          // Centre vertically on the source y so the visible line sits
          // exactly where PowerPoint placed it.
          bounds.y = bounds.y + bounds.h / 2 - strokeWidthIn / 2;
          bounds.h = strokeWidthIn;
        } else {
          bounds.x = bounds.x + bounds.w / 2 - strokeWidthIn / 2;
          bounds.w = strokeWidthIn;
        }
      } else {
        // Diagonal: corner-to-corner with flip handling. Use the line
        // shape and pre-clamp degenerate axes (shouldn't fire for true
        // diagonals but defensive).
        let x1 = 0, y1 = 0, x2 = 100, y2 = 100;
        if (flipH) { x1 = 100; x2 = 0; }
        if (flipV) { [y1, y2] = [y2, y1]; }
        shape.x1 = x1; shape.y1 = y1; shape.x2 = x2; shape.y2 = y2;

        const MIN_LINE_THICKNESS_IN = 1 / PX_PER_IN;
        if (bounds.w <= 0) {
          bounds.x -= MIN_LINE_THICKNESS_IN / 2;
          bounds.w = MIN_LINE_THICKNESS_IN;
        }
        if (bounds.h <= 0) {
          bounds.y -= MIN_LINE_THICKNESS_IN / 2;
          bounds.h = MIN_LINE_THICKNESS_IN;
        }
        // Diagonals also use the fill-as-stroke-color quirk; thickness
        // derived from source a:ln@w but subject to the renderer floor.
        fill = { type: 'solid', color: strokeColor };
        stroke = { type: 'none', color: '#000000', width: 1, dash: 'solid' };
        const refW = bounds.w || bounds.h || 1;
        shape.strokeWidth = (strokeWidthIn / refW) * 100;
      }

      if (APPROXIMATED_AS_LINE.has(prst)) {
        _warn(ctx.report, ctx.slideIndex, 'UNSUPPORTED_CONNECTOR_APPROXIMATED',
          `Slide ${ctx.slideIndex + 1}: ${prst} approximated as a straight line — joints / curves not resolved.`);
      }
    }

    // Name the layer with PowerPoint's <p:cNvPr name="..."> if present so
    // the user can match it back to the source deck in the layer panel.
    const cNvPr = spNode.getElementsByTagName('p:cNvPr')[0]
              || spNode.getElementsByTagNameNS('*', 'cNvPr')[0];
    const sourceName = cNvPr?.getAttribute('name') || '';
    const name = sourceName ? `${label || 'Shape'} (${sourceName})` : (label || 'Shape');

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
        // convertGraphicFrame can return multiple layers — a native
        // chart turns into several rect + text layers. Other graphic
        // frames return a single-element array (the placeholder).
        const result = convertGraphicFrame(child, ctx);
        if (Array.isArray(result) && result.length) {
          layersOut.push(...result);
        }
        // counters are bumped inside convertGraphicFrame.
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
        const text = _runsToPlainText(_readParagraphRuns(p));
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
            slidePath,
            files,
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
      readCategoryLabels,
      readSeriesValues,
      readSeriesName,
      readSeriesColor,
      buildBarChartLayers,
      buildPieChartLayers,
      buildLineChartLayers,
      _sliceArcPath,
      _polylinePathD,
      convertChart,
      walkSpTree,
      readSlideRels,
      readSlideNotes,
    },
  };
})();
