# Artstr Studio PPTX Import

## Editable Import of PowerPoint Decks

### Status

Spec draft. Not yet implemented. This document is the canonical plan;
when work begins it follows this doc, and updates land here first.

This is **import only** for the initial arc. PPTX export (Artstr → `.pptx`)
is a separate later feature with different complexity tradeoffs (OOXML
emission, package-validity testing) and is not in scope here.

---

## 1. Feature Summary

Add a PowerPoint `.pptx` import pathway to Artstr Studio that converts a
user-supplied presentation into an editable Artstr slide deck.

The importer runs entirely in the browser. It reads the `.pptx` zip
package, extracts slide geometry, text boxes, vector shapes, fills,
strokes, colors, notes, and slide metadata where possible, and converts
the result into Artstr's existing deck JSON format.

**Images are not embedded.** Every imported `p:pic` becomes an Artstr
image layer that points at a shared placeholder URL. The user manually
replaces each placeholder with their own image URL after import. This
keeps imported decks small, Nostr-publishable out of the box, and
faithful to Artstr's "remote URLs only" image model.

The first version prioritizes a **reliable editable import** over
PowerPoint visual fidelity. Unsupported or ambiguous content is skipped,
approximated, flattened, or reported to the user — never silently
dropped.

---

## 2. Product Goal

A user uploads a `.pptx` file and Artstr creates a new editable slide
deck from it.

- Imported slides are editable using existing Artstr canvas tools.
- Text becomes Artstr text layers.
- Images become Artstr image layers pointing at the shared placeholder.
- Basic PowerPoint shapes become Artstr shape layers.
- Each PowerPoint slide becomes one Artstr deck slide.
- Speaker notes become Artstr slide notes.

Artstr becomes a lightweight PowerPoint-to-Nostr-presentation bridge.

---

## 3. Non-Goals for Initial Release

The initial release does not attempt full PowerPoint compatibility.
These are **not** supported as editable objects in MVP:

- Animations
- Transitions
- Embedded video / audio playback
- SmartArt as fully editable objects
- Charts as fully editable objects
- Tables as fully editable objects
- Equations as editable math
- Comments / review metadata
- Complex placeholder behavior
- Exact text layout fidelity
- Full master / layout / theme inheritance
- Password-protected or encrypted presentations
- Legacy `.ppt` binary PowerPoint files

Unsupported content lands as a generic placeholder layer plus a warning
in the import report.

---

## 4. Existing Artstr Fit

Artstr already has the pieces required for this feature:

- `templateMode: 'deck'` for slide decks.
- Deck payloads embed every slide inline.
- Each deck slide carries a `slide` object and `layers` array.
- Standalone slides and custom art use the same flat canvas model.
- Canvas layers support text, images, shapes, fills, strokes,
  gradients, opacity, rotation, clipping, and z-order.
- `loadProjectFromText` understands deck payloads and routes through the
  same path as JSON load-from-file.

The importer produces a normal Artstr deck payload and feeds it into
the existing project-loading path.

---

## 5. Target JSON Shape

```js
{
  version: SCHEMA_VERSION,
  templateMode: 'deck',
  templateType: 'deck',
  meta: {
    title: 'Imported deck title',
    imdbId: '',
    upc: '',
    tvdbId: '',
    musicbrainzDiscId: '',
    customTag: '',
    category: 'presentation',
    language: 'en'
  },
  deck: {
    theme: {
      fontFamily: '',
      background: ''
    },
    slides: [
      {
        name: 'Slide 1',
        slide: {
          width: 1920,
          height: 1080,
          background: '#ffffff',
          notes: ''
        },
        layers: [
          // Artstr canvas layers
        ],
        ignoreDeckTheme: true
      }
    ]
  }
}
```

Imported slides default to `ignoreDeckTheme: true` so an Artstr deck
theme does not unexpectedly override imported PowerPoint styling.

---

## 6. UX

### 6.1 Entry Point

Add an **Import PPTX** action in the Deck Builder UI, distinct from
"Load from file" (which is the JSON path).

```html
<button type="button" id="importPptxBtn">Import PPTX</button>
<input
  id="pptxFileInput"
  type="file"
  accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
  hidden
/>
```

### 6.2 Flow

1. User clicks **Import PPTX**.
2. If this is the first click of the session, lazy-load the importer
   module (see §7.3). Show a one-time inline spinner: "Loading PPTX
   importer…"
3. Browser file picker opens.
4. User chooses a `.pptx` file.
5. Artstr parses the file in-browser.
6. Artstr creates a new deck payload.
7. Artstr loads the payload into the existing editor.
8. Artstr shows the import report modal.

### 6.3 Replace Current Project Confirmation

If the current project has unsaved content, reuse the existing
close/save confirmation pattern:

> Importing a PowerPoint file will replace the current deck.
>
> [Cancel] [Save JSON, then Import] [Import Anyway]

### 6.4 Import Report Modal

After import, show a summary:

```
Imported: presentation.pptx
Slides: 18
Text boxes: 142
Image placeholders: 24
Shapes: 61
Skipped (placeholders shown): 3 charts, 1 video, 2 SmartArt objects
Warnings: 12 style approximations

Note: 27 images and unsupported objects were imported as placeholders.
Open each placeholder layer and paste an image URL to restore.
```

Each warning is human-readable, not technical:

- "Slide 4: chart imported as placeholder."
- "Slide 7: unsupported shape geometry approximated as a rectangle."
- "Slide 9: some text spacing may differ from PowerPoint."

### 6.5 Placeholder Visibility in the Layer List

Every placeholder layer's `name` carries the original PowerPoint object
identifier so the user can match it back to the source deck:

- Picture from `ppt/media/image3.png` → `Image: image3.png`
- Chart → `Chart placeholder: chart1`
- SmartArt → `SmartArt placeholder: diagram1`
- Table → `Table placeholder: 4×3`
- Video → `Video placeholder: clip1.mp4`

---

## 7. Technical Architecture

### 7.1 Importer Pipeline

```
File input
  → ArrayBuffer
  → unzip PPTX package
  → parse presentation.xml
  → resolve slide order and slide size
  → parse theme / layout / master data where available
  → parse each slide XML
  → resolve each slide's relationships
  → convert PowerPoint objects to Artstr layers
  → create Artstr deck payload
  → load deck into Artstr
  → show import report
```

### 7.2 Zip Library

Use **fflate** vendored as `src/vendor/fflate.min.js` (~10 KB
minified). It is the smallest browser-compatible zip library with a
straightforward `unzipSync` / `unzip` API. JSZip would be ~10× larger
and is not justified given the single-file-app ethos. Same vendoring
pattern as `src/noble-bundle.min.js`.

### 7.3 Lazy Module Loading

PPTX import is rare relative to overall app usage. Loading the
importer + fflate eagerly in `index.html` would inflate first-paint
weight for 90 % of users who never click Import.

Approach:

- Extract the importer + the conversion functions into
  `src/pptx-importer.js` (a single file, IIFE-exported as
  `window.ArtstrPptxImporter`).
- Vendor `fflate.min.js` alongside `noble-bundle.min.js`.
- The Import PPTX button handler dynamically injects both scripts on
  first click:

```js
async function ensurePptxImporterLoaded() {
  if (window.ArtstrPptxImporter) return;
  await loadScriptOnce('./vendor/fflate.min.js');
  await loadScriptOnce('./pptx-importer.js');
}
```

- Show a small loading indicator next to the button while the scripts
  load. On slow connections this is a few hundred ms; on fast it is
  imperceptible.

### 7.4 XML Parsing

Use native `DOMParser`:

```js
const parser = new DOMParser();
const doc = parser.parseFromString(xmlText, 'application/xml');
```

No external XML library. PPTX XML is well-behaved enough for the
browser parser to handle without special namespace gymnastics.

---

## 8. PPTX Package Files Read

A `.pptx` is a zip package of XML files and media assets.

MVP files (Phases 1–3):

```
ppt/presentation.xml
ppt/_rels/presentation.xml.rels
ppt/slides/slideN.xml
ppt/slides/_rels/slideN.xml.rels
ppt/notesSlides/notesSlideN.xml         (Phase 2)
ppt/notesSlides/_rels/notesSlideN.xml.rels
```

The `ppt/media/*` files are **not read** — we never decode the actual
image bytes; every picture becomes a placeholder URL. We only read the
relationship metadata to confirm a picture existed and to extract the
original filename for the layer `name`.

Phase 6 files (theme / layout / master):

```
ppt/theme/themeN.xml
ppt/slideLayouts/slideLayoutN.xml
ppt/slideLayouts/_rels/slideLayoutN.xml.rels
ppt/slideMasters/slideMasterN.xml
ppt/slideMasters/_rels/slideMasterN.xml.rels
```

---

## 9. Coordinate System

PowerPoint uses EMUs. Artstr slide canvases are pixel-like.

Normalize all imports to a 1920 × 1080 canvas.

```js
const EMU_PER_IN = 914400;
const PT_PER_IN  = 72;
const EMU_PER_PT = 12700;
```

Read slide size from `p:sldSz`:

```xml
<p:sldSz cx="12192000" cy="6858000" type="wide"/>
```

Scale + xfrm conversion:

```js
function makePptxScale(slideSize, targetW = 1920, targetH = 1080) {
  return {
    x: targetW / slideSize.cx,
    y: targetH / slideSize.cy
  };
}

function convertXfrm(xfrm, scale) {
  const off = xfrm.off || { x: 0, y: 0 };
  const ext = xfrm.ext || { cx: 0, cy: 0 };
  return {
    x: off.x * scale.x,
    y: off.y * scale.y,
    w: ext.cx * scale.x,
    h: ext.cy * scale.y,
    rotate: pptxRotationToDegrees(xfrm.rot || 0)
  };
}

function pptxRotationToDegrees(rot) {
  return (Number(rot) || 0) / 60000;
}
```

---

## 10. Object Conversion Matrix

| PowerPoint XML           | Meaning            | Artstr conversion                    | MVP?    |
| ------------------------ | ------------------ | ------------------------------------ | ------- |
| `p:sp` with `p:txBody`   | Text box           | `type: 'text'`                       | Yes     |
| `p:sp` with `a:prstGeom` | Preset shape       | `type: 'shape'`                      | Yes     |
| `p:pic`                  | Image              | `type: 'image'` with placeholder src | Yes     |
| `p:grpSp`                | Group              | Flatten children with parent xfrm    | Yes     |
| `a:solidFill`            | Solid fill         | `fill: { type: 'solid' }`            | Yes     |
| `a:ln`                   | Stroke             | `stroke: { type: 'solid' }`          | Yes     |
| `a:gradFill`             | Gradient fill      | Artstr gradient fill                 | Phase 6 |
| `a:custGeom`             | Custom geometry    | Custom path shape                    | Phase 6 |
| `p:graphicFrame` chart   | Chart              | Image-layer placeholder              | Yes     |
| `p:graphicFrame` table   | Table              | Image-layer placeholder              | Yes     |
| SmartArt                 | Diagram            | Image-layer placeholder              | Yes     |
| Video / audio            | Media              | Image-layer placeholder              | Yes     |
| Animations               | Animation          | Ignore                               | Later   |

---

## 11. Layer Mapping Details

### 11.1 Text Layers

PowerPoint source:

```xml
<p:sp>
  <p:spPr>...</p:spPr>
  <p:txBody>...</p:txBody>
</p:sp>
```

Artstr target:

```js
{
  id: makeLayerId(),
  type: 'text',
  name: 'Text',
  target: 'canvas',
  html: 'Imported text',
  x, y, w, h, rotate, opacity, z,
  fontFamily, fontSize, color, align,
  bold, italic
}
```

MVP text behavior:

- Extract plain text from paragraphs / runs.
- Preserve paragraph breaks as `<br>` or separate block text.
- Use the first run's dominant style for the whole Artstr text box.
- Preserve rough alignment.
- Preserve bold / italic if dominant.
- Preserve explicit font size and color.

Per-run rich-text spans (mid-line bold, color changes, etc.) are not
attempted in MVP. The import report warns: "Slide N: some text styling
may have been simplified."

### 11.2 Image Placeholder Layers

PowerPoint source:

```xml
<p:pic>
  <p:nvPicPr>
    <p:cNvPr id="..." name="..."/>
  </p:nvPicPr>
  <p:blipFill>
    <a:blip r:embed="rId5" />
  </p:blipFill>
  <p:spPr>
    <a:xfrm>...</a:xfrm>
  </p:spPr>
</p:pic>
```

We resolve `rId5` through `ppt/slides/_rels/slideN.xml.rels` only to
extract the original media filename (e.g. `media/image3.png`). We do
**not** read the media file itself.

Artstr target:

```js
{
  id: makeLayerId(),
  type: 'image',
  name: 'Image: image3.png',
  src: PPTX_IMAGE_PLACEHOLDER_URL,
  target: 'canvas',
  x, y, w, h, rotate, opacity, z
}
```

Where:

```js
const PPTX_IMAGE_PLACEHOLDER_URL =
  'https://i.postimg.cc/9fY3n60q/example-image-replace-me.png';
```

The placeholder URL is hardcoded. If we ever want to host our own copy
or upload to Blossom later, swapping the constant is a one-line change.

This is the load-bearing architectural choice for the whole arc:
zero base64 bloat, decks remain Nostr-publishable, the importer never
reads media bytes from the zip package.

### 11.3 Shape Layers

PowerPoint source:

```xml
<p:sp>
  <p:spPr>
    <a:xfrm>...</a:xfrm>
    <a:prstGeom prst="rect" />
    <a:solidFill>...</a:solidFill>
    <a:ln>...</a:ln>
  </p:spPr>
</p:sp>
```

Artstr target:

```js
{
  id: makeLayerId(),
  type: 'shape',
  name: 'Rectangle',
  target: 'canvas',
  x, y, w, h, rotate, opacity, z,
  shape: { kind: 'rect' },
  fill:   { type: 'solid', color: '#ffffff' },
  stroke: { type: 'solid', color: '#000000', width: 2, dash: 'solid' }
}
```

Preset shape mapping:

| PPTX `prst`          | Artstr shape kind      |
| -------------------- | ---------------------- |
| `rect`               | `rect`                 |
| `roundRect`          | `rounded-rect`         |
| `ellipse`            | `ellipse`              |
| `triangle`           | `triangle`             |
| `line`               | `line`                 |
| `straightConnector1` | `line`                 |
| `star5`              | `star`                 |
| `hexagon`            | `polygon` with sides 6 |
| `pentagon`           | `polygon` with sides 5 |

Unsupported presets:

- MVP: convert to a generic rectangle + warn
  `UNSUPPORTED_SHAPE_APPROXIMATED`.
- Phase 6: convert to custom SVG paths via `a:custGeom`.

### 11.4 Unsupported-Object Placeholder Layers

Charts (`p:graphicFrame` with chart payload), tables (`p:graphicFrame`
with table payload), SmartArt (`p:graphicFrame` with diagram payload),
and video / audio (`p:pic` with video relationship) all become image
layers pointing at the same placeholder URL, with their `name`
describing the original object:

```js
{
  id: makeLayerId(),
  type: 'image',
  name: 'Chart placeholder: chart1',         // or 'SmartArt placeholder: …', etc.
  src: PPTX_IMAGE_PLACEHOLDER_URL,
  target: 'canvas',
  x, y, w, h, rotate, opacity, z
}
```

This keeps the slide visually populated and editable, and the user can
replace each placeholder with a real image, screenshot, or recreate the
content using Artstr tools.

### 11.5 Backgrounds

PowerPoint slide backgrounds may come from the slide, layout, master,
or theme.

- MVP: read direct slide background only; default to `#ffffff`.
- Phase 6: resolve layout / master inherited background.

Artstr target:

```js
slide: {
  width: 1920,
  height: 1080,
  background: '#ffffff',
  notes: ''
}
```

### 11.6 Notes

PowerPoint notes live in `ppt/notesSlides/notesSlideN.xml`. The slide's
relationships file points at the corresponding notes slide.

MVP (Phase 2, alongside text):

- Follow the slide's relationship to its notes slide.
- Extract plain text from the notes slide's text body.
- Store in `slide.notes`.

Artstr Presenter Mode already renders `slide.notes`, so this lights up
the feature with no other wiring.

---

## 12. Theme and Color Resolution

PowerPoint color sources:

- Direct RGB.
- Scheme colors (`accent1`, `tx1`, `bg1`, etc).
- Preset colors.
- System colors.
- Tint / shade / luminance modifiers.

MVP color support:

- `a:srgbClr val="RRGGBB"` → `#RRGGBB`.
- `a:solidFill` with direct colors only.
- Unknown colors → black or transparent depending on context, with a
  `THEME_COLOR_UNRESOLVED` warning.

Phase 6 color support:

- Parse `ppt/theme/themeN.xml`.
- Resolve `a:schemeClr` against the theme color scheme.
- Apply tint / shade / luminance modifiers approximately.

```js
function resolvePptxColor(node, context) {
  // 1. srgbClr
  // 2. schemeClr via theme map (Phase 6)
  // 3. presetClr
  // 4. sysClr fallback
  // 5. default
}
```

---

## 13. Import Report Data Model

```js
const report = {
  fileName: '',
  slideCount: 0,
  imported: {
    text: 0,
    images: 0,           // image placeholders
    shapes: 0,
    groups: 0,
    backgrounds: 0,
    notes: 0
  },
  placeholders: {
    charts: 0,
    smartArt: 0,
    tables: 0,
    media: 0,
    unknown: 0
  },
  warnings: [
    {
      slideIndex: 3,
      code: 'UNSUPPORTED_CHART_PLACEHOLDER',
      message: 'Slide 4: chart was imported as a placeholder image.'
    }
  ]
};
```

Warning codes:

```
UNSUPPORTED_CHART_PLACEHOLDER
UNSUPPORTED_SMART_ART_PLACEHOLDER
UNSUPPORTED_TABLE_PLACEHOLDER
UNSUPPORTED_MEDIA_PLACEHOLDER
UNSUPPORTED_ANIMATION_IGNORED
UNSUPPORTED_SHAPE_APPROXIMATED
MISSING_IMAGE_RELATIONSHIP
TEXT_STYLE_APPROXIMATED
THEME_COLOR_UNRESOLVED
LAYOUT_INHERITANCE_PARTIAL
MASTER_INHERITANCE_PARTIAL
```

---

## 14. Implementation Plan

### Phase 0: Prep — SHIPPED on `pptx-import` (commit `d710b84`)

- Vendor `fflate.min.js` at `src/vendor/fflate.min.js`.
- Add empty `src/pptx-importer.js` exporting
  `window.ArtstrPptxImporter`.
- Wire `loadScriptOnce` helper + `ensurePptxImporterLoaded` in
  `index.html`.
- Add Import PPTX button + hidden file input in the Deck Builder UI.
- Add import report modal shell.

Deliverable: User can click Import PPTX, scripts load, file picker
opens, file extension is validated, importer stub returns "not
implemented yet."

Status: shipped. Phase 1+ paused while we work on a purchase-vault
fix on `main`. Branch `pptx-import` retains the Phase 0 commit so
work can resume here without setup.

### Phase 1: Deck Shell — SHIPPED on `pptx-import` (commit `2cc2b85`)

- Read `.pptx` as ArrayBuffer.
- Unzip with fflate.
- Parse `ppt/presentation.xml` and `ppt/_rels/presentation.xml.rels`.
- Read slide size from `p:sldSz`.
- Resolve slide order.
- Create one Artstr deck slide per PowerPoint slide.
- Default `#ffffff` background. No layers yet.

Acceptance: Importing a PPTX creates a deck with the correct number of
slides; deck loads in the Deck Builder; each slide is editable.

Status: shipped. Verified via CDP smoke test against synthetic 3-slide
and 5-slide `.pptx` files built in-browser with `fflate.zipSync`.
Garbage bytes throw a clean "invalid zip data" error.

### Phase 2: Text + Notes

- Parse `p:sp` with `p:txBody`.
- Extract text content (paragraphs / runs).
- Extract bounds from `a:xfrm`.
- Convert to text layers with basic style (font size, color, bold,
  italic, alignment).
- Follow notes-slide relationship per slide and extract notes text into
  `slide.notes`.

Acceptance: Text appears at roughly correct positions, editable in
Artstr; multi-line text imports with line breaks; speaker notes appear
in Presenter Mode.

### Phase 3: Image Placeholders + Unsupported-Object Placeholders

- Parse `p:pic`.
- Read the embed-relationship to extract the original media filename
  (for the layer `name`); do **not** read media bytes.
- Create image layers with `src = PPTX_IMAGE_PLACEHOLDER_URL`.
- Detect `p:graphicFrame` chart / table / SmartArt and create
  placeholder image layers with descriptive names.
- Detect video / audio in `p:pic` (via relationship type) and create
  placeholder image layers.
- Emit appropriate warnings.

Acceptance: Image-bearing decks import with placeholder layers at
correct positions; chart / SmartArt / table / video objects show as
labeled placeholders; nothing silently disappears.

### Phase 4: Basic Shape Import — SHIPPED on `pptx-import` (commit `3def41b`)

- Parse `p:sp` with `a:prstGeom` and no text body.
- Map common preset shapes (rect, roundRect, ellipse, triangle, line,
  star5, hexagon, pentagon, straightConnector1).
- Read solid fills and strokes.
- Preserve opacity and rotation.

Acceptance: Basic preset shapes import as editable shape layers; fill
and stroke colors roughly match the PowerPoint file.

Status: shipped (intentionally landed before Phase 2 / Phase 3 because
the user's test deck is a design-template set, heavy on
backgrounds + shapes and light on text). Verified against
`gallery_template_layout_set.pptx` (16 slides → 64 shape layers with
correct source colors and positions, zero warnings).

### Phase 5: Group Flattening

- Parse `p:grpSp` recursively.
- Apply parent transform to child transforms.
- Flatten children into normal Artstr layers.

Acceptance: Objects inside PowerPoint groups appear in the right
approximate position; the import does not need to preserve grouping
semantics.

### Phase 6: Theme / Layout / Master Improvements

- Parse slide-layout and slide-master relationships.
- Parse theme XML.
- Resolve theme colors (`a:schemeClr`).
- Resolve inherited slide backgrounds.

Acceptance: Decks that lean on theme colors import with closer visual
fidelity; theme colors resolve to real hex.

### Phase 7: Polish

- Tune the import report wording.
- Improve text-style fidelity (per-run spans if Artstr's rich-text
  layer can support them cleanly).
- Add a per-slide warning summary in the report modal.

---

## 15. Function Layout

All importer code lives in `src/pptx-importer.js`, exposed as
`window.ArtstrPptxImporter` (mirrors the noble-bundle pattern).

```js
window.ArtstrPptxImporter = (function () {
  async function importPptxFile(file) {}
  async function readPptxPackage(file) {}
  function parseXml(xmlText) {}
  function readPresentationInfo(zip, parser, report) {}
  function readPresentationRels(zip, parser) {}
  function readSlideRefsInOrder(presDoc, presRelsDoc) {}
  function readSlideSize(presDoc) {}
  async function convertPptxSlide(zip, slideRef, context) {}
  function convertSlideShape(spNode, context) {}
  function convertTextShape(spNode, context) {}
  function convertPicture(picNode, context) {}
  function convertPresetShape(spNode, context) {}
  function convertGroupShape(grpSpNode, context) {}
  function convertGraphicFrame(gfNode, context) {}  // chart / table / smart-art
  function readXfrm(node) {}
  function readFill(node, context) {}
  function readStroke(node, context) {}
  function resolvePptxColor(node, context) {}
  function resolveRelationship(relsDoc, rId) {}
  function pptxTargetToZipPath(basePath, target) {}
  function makePptxImportReport(fileName) {}

  return { importPptxFile, makePptxImportReport };
})();
```

The report-modal render lives in `index.html` (uses existing modal
styling), called as `showPptxImportReport(report)`.

---

## 16. Pseudocode

```js
async function onImportPptxClick() {
  await ensurePptxImporterLoaded();
  document.getElementById('pptxFileInput').click();
}

async function onPptxFileChosen(file) {
  if (!file || !/\.pptx$/i.test(file.name)) {
    toastError('Please choose a .pptx file.');
    return;
  }
  if (hasUnsavedWork() && !(await confirmReplaceProject())) return;

  const report = ArtstrPptxImporter.makePptxImportReport(file.name);
  try {
    const payload = await ArtstrPptxImporter.importPptxFile(file, report);
    loadProjectFromText(JSON.stringify(payload));
    showPptxImportReport(report);
  } catch (err) {
    console.error(err);
    toastError(`Could not import PPTX: ${err?.message || err}`);
  }
}
```

`importPptxFile` returns the Artstr deck payload (does not call
`loadProjectFromText` itself, so it is easier to unit-test).

---

## 17. Security and Privacy

The importer runs locally in the browser. The PPTX file is never
uploaded.

- Do not execute embedded scripts.
- Do not follow external relationships.
- Do not fetch external media. (Media is never decoded at all; only
  filenames are read for layer naming.)
- Catch parser errors and fail gracefully.
- Sanitize imported text before assigning to `html` (use the same
  sanitizer Artstr's text layer already uses on paste).

Suggested limits:

```js
const PPTX_MAX_FILE_BYTES   = 100 * 1024 * 1024;
const PPTX_MAX_SLIDES_WARN  = 100;
```

There is no max data-URL warning (no data URLs are produced).

---

## 18. Performance

- Show progress text while importing (`Slide 12 / 48…`).
- Yield to the browser between slides with
  `await new Promise(requestAnimationFrame)`.
- XML parsing of a typical 50-slide deck is fast (sub-second on
  desktop). A Web Worker is not necessary for MVP.

Memory footprint is small because no media bytes are decoded.

---

## 19. Testing Plan

### 19.1 Test Decks

Build a small library of `.pptx` files under `test/pptx/`:

1. Blank 16:9 deck.
2. Text-only deck.
3. Text with bold / italic / colors / alignment.
4. Basic shapes (rect, rounded rect, ellipse, line, triangle).
5. Image-heavy deck (PNG + JPEG).
6. Grouped objects.
7. Theme colors and master background.
8. Speaker notes.
9. Unsupported content (chart, SmartArt, table, video).
10. Large deck (50+ slides).

### 19.2 Unit-ish Tests

Build a debug harness page (`test/pptx/harness.html`) that runs parser
functions against known XML strings.

Helpers to test in isolation:

- `readSlideSize`
- `resolveRelationship`
- `pptxTargetToZipPath`
- `readXfrm`
- `resolvePptxColor`
- `convertTextShape`
- `convertPresetShape`
- `convertPicture` (verify placeholder URL + filename in name)
- `convertGraphicFrame` (verify placeholder for chart / table /
  SmartArt)

### 19.3 Manual Acceptance

For each test deck:

- Import completes without crashing.
- Correct slide count.
- Layers appear in expected z-order.
- Text is editable.
- Image / chart / SmartArt / table / video placeholders appear at
  correct positions.
- Basic shapes are editable.
- Save JSON and reload round-trips.
- Presenter Mode works (and shows notes).
- Import report accurately describes skipped content.

---

## 20. Acceptance Criteria for MVP Release

- A user can select a `.pptx` file from the browser.
- Artstr creates a new `templateMode: 'deck'` project.
- Slide count matches the PowerPoint file.
- Slide dimensions normalize to Artstr's 16:9 canvas.
- Text boxes import as editable text layers (with notes).
- Images import as placeholder image layers pointing at
  `PPTX_IMAGE_PLACEHOLDER_URL`, with the original media filename in the
  layer name.
- Charts / SmartArt / tables / video import as placeholder image
  layers with descriptive names.
- Basic rectangles, ellipses, lines, and triangles import as editable
  shape layers.
- Solid fills and strokes are imported where explicit.
- Rotation, opacity, z-order, and rough position are preserved.
- Unsupported objects produce warnings; nothing silently disappears.
- Imported deck saves as Artstr JSON and reloads cleanly.
- Imported deck opens in Presenter Mode.
- Imported deck publishes to Nostr without size warnings (because no
  base64 bloat).

---

## 21. Publishing Considerations

Imported decks are normal Artstr deck payloads with remote image URLs.
They publish to Nostr like any other deck. No special warnings, no
externalization step, no size guard.

The placeholder URL is a third-party host (postimg.cc). Trade-offs:

- If postimg.cc goes away, every placeholder layer 404s. The deck
  itself still loads; the placeholder image just doesn't render.
- We may want to host our own copy long-term. Swapping
  `PPTX_IMAGE_PLACEHOLDER_URL` is a one-line change; old imported
  decks keep their existing URL until the user edits the layer.

---

## 22. Main Risks

### Risk: PowerPoint fidelity expectations are too high

Mitigation: ship copy that frames this as "Import editable PPTX," not
"Perfect PowerPoint renderer." Import report makes approximations and
placeholders visible.

### Risk: Theme / master inheritance is complex

Mitigation: deferred to Phase 6. MVP reads direct slide objects only.

### Risk: Placeholder URL host disappears

Mitigation: noted in §21. The constant is trivial to swap. Long-term
we may self-host or upload to Blossom.

### Risk: Text reflow differences

Mitigation: preserve box size and explicit font size. Warn that some
text layout may differ. Per-run rich-text is a Phase 7 enhancement.

### Risk: Single-file code size grows too much

Mitigation: importer lives in its own file (`src/pptx-importer.js`)
and is lazy-loaded. The main `index.html` bundle does not grow.

---

## 23. First PR Scope (Phase 0 + Phase 1)

- Vendor `fflate.min.js`.
- Stand up `src/pptx-importer.js` with the IIFE shell.
- Add `loadScriptOnce` + `ensurePptxImporterLoaded` in `index.html`.
- Add Import PPTX button, hidden file input, and report-modal shell in
  the Deck Builder UI.
- Implement the deck-shell import: file → unzip → presentation.xml →
  slide order → empty slides.
- Show a minimal import report (slide count only).

Do not include text, images, shapes, themes, or notes in the first PR.

This gives a working vertical slice and proves the architecture.

---

## 24. Second PR Scope (Phase 2)

- Text-box import with basic style.
- Speaker notes import.
- Real warnings populating the report.

---

## 25. Third PR Scope (Phase 3 + Phase 4)

- Image placeholder layers (with original filename in `name`).
- Chart / SmartArt / table / video placeholder layers.
- Basic shape import with fill + stroke.

---

## 26. Long-Term Enhancements

- Per-run rich-text spans for higher text fidelity.
- Convert unsupported preset shapes to custom SVG paths
  (`a:custGeom`).
- Self-hosted placeholder image (or rotate through several variants
  per object type).
- Optional "Replace all placeholders…" panel that lists every
  placeholder layer in the deck and lets the user paste URLs in batch.
- Side-by-side visual diff against a rasterized reference render.
- PPTX **export**: Artstr deck → `.pptx` package. A separate later
  arc.

---

## 27. Final Recommendation

Build this as a phased editable importer, not a PowerPoint renderer.
The placeholder strategy is what makes the architecture clean: no
embedded binaries, no externalization prereq, no publish-size guard,
and Artstr's "remote URLs only" image model is preserved end to end.

The product promise:

> "Import a PowerPoint deck into Artstr as editable slides. Images and
> a few advanced PowerPoint object types come in as placeholders —
> open each layer and paste your own image URL to restore them."
