# Custom Art Mode

## Goals
Add a fifth template mode — **Custom Art** — alongside the existing cover, disc, jewel, and disc-design modes. The aim is to let CaseWrap Studio be used for general-purpose digital art at arbitrary aspect ratios (wallpapers, banners, social posts, posters, etc.) while keeping everything else about the app — Nostr publish/share, layer system, soft-moderation, mini-preview browser — intact.

### Product goals
1. Let a user create a blank canvas at any reasonable size, add the same layer types as elsewhere (image, text, color), and publish it through the existing Nostr flow.
2. Browse, filter, and re-use custom-art designs in the community template browser.
3. Keep the codebase complexity bounded — reuse layer / preview / publish / share machinery as much as possible.

### Non-goals (v1)
- Vector tools (SVG paths, freehand drawing, brushes). Layers remain image/text/color.
- Inches/DPI handling for Custom Art — pixels only.
- Print-targeted features (bleed, trim, crop marks) — these are digital-only canvases.
- Real-time collaborative editing.
- Templates / starting decks (e.g., "Instagram post starter"). v1 has no in-app starting points beyond the size presets.
- Animated / multi-frame art.
- Larger than 8192×8192 canvases.
- Stickers / shape primitives (rectangles, circles, lines as drawn shapes — beyond the color-fill layer which is rectangular).

---

## Current state in the app
The four existing modes (cover, disc, jewel, disc-design) all use:
- **Inches** as the unit of measure (because the source product is physical media).
- **Fixed dimensions** specific to the product (e.g., DVD cover trim = 10.675 × 7.5 in).
- **Multiple slots** within the sheet (back/spine/front, disc-top/disc-bottom, jewel-front/jewel-tray).
- A `templateMode` value in state and payloads that controls editor behaviour, render code paths, publish d-tag prefix, and browse-filter visibility.

Layers are global to the design and assigned to a target region via `layer.target`. The render path applies layers within their target's coord space.

The Nostr publish path uses NIP-78 kind-30078 with a `t` tag (`casewrap`) plus a per-mode type tag (`casewrap-cover`, `casewrap-disc-design`, etc.) and a d-tag prefixed with the mode for uniqueness.

The template browser groups designs by `templateMode` for the type filter (`cover` / `disc` / `jewel` / `disc-design` / `any`).

---

## Custom Art mode at a glance

| Aspect | Existing modes | Custom Art mode |
|---|---|---|
| Unit | Inches | Pixels |
| Dimensions | Fixed per product | User-chosen (min 100×100, max 8192×8192) |
| Slots / regions | Multiple | One: the canvas |
| Background | Slot-specific artwork | Optional configurable fill color (default white) |
| Bleed / trim | Yes | No |
| Layer target | `back`, `front`, `disc-top`, etc. | `canvas` |
| Print-ready PDF | Yes | Not the primary use case (digital) |
| Export JPEG | Yes | Yes (primary use case) |
| Nostr publish | Yes | Yes (same kind, new type tag) |
| Mini-preview card silhouette | Cover-rect / disc-circle / jewel-sheet | Arbitrary aspect rectangle matching the canvas |

---

## Decisions (locked in)

1. **Units**: Pixels only. Fixed 96 px/in conversion when interacting with layer math that's already inch-based. Pixel-first API on the surface, internal inch-equivalent where the existing layer code needs it.

2. **Size limits**: 100 × 100 px minimum, 8192 × 8192 px maximum. Bounds enforced on input and clamped on load. (Avoids canvas memory crashes; 8K is the practical upper limit for `<img>` and `<canvas>` reliably across browsers.)

3. **Preset sizes** (built into a "preset" dropdown):
   - 1920 × 1080  — Desktop wallpaper / 16:9
   - 1080 × 1920  — Phone wallpaper / 9:16
   - 2560 × 1440  — QHD wallpaper
   - 3840 × 2160  — 4K wallpaper
   - 1080 × 1080  — Square / 1:1 (Instagram post)
   - 1080 × 1350  — 4:5 portrait (Instagram)
   - 1500 × 500   — 3:1 banner (Twitter header)
   - 850 × 1100   — US Letter portrait (digital)
   - 1100 × 850   — US Letter landscape (digital)
   - Custom…     — exposes width/height inputs

4. **Browser size filter scope**: Only for Custom Art. The cover/disc/jewel modes already have well-defined product dimensions; a size filter would be noise there. Custom Art's size filter is a separate select that appears only when the Custom Art type filter is selected (or "Any").

5. **Canvas background**: Per-design configurable fill color (hex). Default white (`#ffffff`). Stored as `payload.customArt.background` in the payload.

6. **Nostr publish**: Same NIP-78 kind-30078 flow. `t` tag stays `casewrap`. New per-mode tag `casewrap-customart`. Existing template_type / category / language / title tags all apply.

7. **D-tag prefix**: `customart:<dValueBase>` where `dValueBase` is the user's imdbId / title / `width-x-height` fallback. Same pattern as the other modes (`cover:`, `disc-design:`, etc.) so addressing stays distinct from other content types for the same title.

8. **Phasing**: One spec, three implementation chunks.
   - **Phase A** — Editor: state, mode switch, blank canvas editor, size controls, layer support, save/load JSON.
   - **Phase B** — Publish + share: Nostr publish, share-link round-trip via `naddr`/`nevent`.
   - **Phase C** — Browser: type filter option, size filter, mini-preview, full preview pane, JPEG export.

Each phase is independently shippable.

---

## Data model

### `state.customArt`
New top-level field, mirrors `state.discDesign` and `state.combined`:
```js
state.customArt = {
  width: 1920,            // px, 100–8192
  height: 1080,           // px, 100–8192
  background: '#ffffff',  // optional fill color
  preset: '1920x1080'     // key of last-applied preset, or 'custom'
};
```

### `state.meta`
Unchanged. The existing `title / identifiers / category / language` apply to custom art designs too.

### `state.layers`
Unchanged. New layers in custom-art mode get `target: 'canvas'`.

### Payload
```js
function customArtPayload() {
  return {
    version: SCHEMA_VERSION,
    templateMode: 'customart',
    templateType: 'customart',
    meta: state.meta,
    ui: { zoom: state.zoom, showGuides: state.showGuides },
    customArt: { ...state.customArt },
    layers: nonGeneratedLayers().filter(l => l.target === 'canvas'),
    community: { /* ... */ }
  };
}
```

### Mode detection (`normalizeTemplateMode`)
Extends the existing detector:
```js
if (raw === 'customart') return 'customart';
// fallback heuristic:
if (payload.customArt) return 'customart';
```

---

## UI changes

### Layout-mode tabs
Currently the sidebar has a row of layout-tab buttons: `Case cover`, `Disc labels`. (Jewel is hidden behind a preset selector.) Add a third button: `Custom art`.

### Custom Art controls fieldset (new)
New `<fieldset class="workflowStep template-only" id="customArtFieldset">` shown only when `state.templateMode === 'customart'`:

```
[ Canvas size ]
  Preset: [ Custom… ▼ ]      ← dropdown of presets + Custom
  Width:  [   ] px
  Height: [   ] px
[ Background ]
  Fill color: [color picker]   Transparent: [ ] checkbox
```

Hidden in all other modes via the existing `template-cover` / `template-disc` / `template-jewel` body-class system, adding a new `template-customart` body class.

### Editor view
- Single rectangular canvas at the user's chosen pixel dimensions, centered in the preview shell.
- No bleed/trim/safe-area markers.
- Layers stack on the canvas with `target: 'canvas'`.
- Layer-target options dropdown shows only `Canvas` for this mode.
- Print/Save PDF and Export JPEG buttons available.

### Template browser
- "Type" filter dropdown gains `Custom art` option (alongside existing cover/disc/jewel/disc-design).
- When `Custom art` or `Any` is selected, a new "Size" filter dropdown appears:
  ```
  Any size · 16:9 · 9:16 · 1:1 · 4:5 · 4:3 · 3:1 · Letter · Other
  ```
- Bucketing logic computes the aspect ratio of `(payload.customArt.width / payload.customArt.height)` and matches into the nearest bucket (within ±2% tolerance). "Other" catches anything outside the named buckets.

---

## Preview renderers

### `renderCustomArtPreviewDOM(container, payload, opts)`
- Reads `payload.customArt.{width,height,background}`.
- Creates a sized div with that pixel aspect ratio, scaled to fit the preview pane (full mode) or thumbnail (compact mode via the existing `fitMiniPreview` transform).
- Applies the background color (or white if transparent).
- Renders layers with `target === 'canvas'` using the same layer-positioning math as the disc renderer, but with `pxPerInch` derived from canvas-width-in-pixels: `pxPerInch = naturalWidth / (width_in_px / 96)`. *(Note: since layers in Custom Art are positioned in pixels, we may simplify to just pass `naturalWidth / width` as the scale factor for `applyPreviewLayerTextStyle`.)*

Compact mode: same as the others — no labels, no shadow.

---

## Layer positioning

Two reasonable approaches:

**Option 1**: Layers store positions in **pixels** (consistent with Custom Art's chosen unit). The renderer divides by canvas dimensions to get percentages.
- Pro: User-natural.
- Con: Inconsistent with the other modes which use inches.

**Option 2**: Layers store positions in **inches** at 96 DPI (consistent with existing layer code). The renderer treats canvas as `(width_px / 96)` × `(height_px / 96)` inches.
- Pro: Reuses every existing layer helper unchanged.
- Con: User thinks in pixels but the data is inches — slight cognitive mismatch.

**Pick: Option 2**. Lower implementation risk. The user interacts via the canvas-size picker in pixels; layers internally use inches at 96 DPI. The size input UI displays pixels.

For example: 1920 × 1080 canvas → internally `panelW = 20`, `panelH = 11.25` inches. Layer at (200px, 100px) on the canvas would be `(2.083, 1.042)` in inches.

A small helper `customArtCanvasInches(state.customArt) → { wIn, hIn }` exposes the inch dimensions to the layer math.

---

## Publish d-tag

Following the existing pattern:
```js
['d', `customart:${state.meta.imdbId || state.meta.title || `${state.customArt.width}x${state.customArt.height}`}`]
```

Allows the same title to have a custom-art design *plus* a cover/disc/disc-design without colliding.

---

## Export

### JPEG (primary)
- Already-built `exportArtboardAsJpeg` flow works with one tweak: for Custom Art, the export PDF uses `@page size: ${widthIn}in ${heightIn}in; margin: 0;` (where `widthIn = width_px / 96`). The trim-area crop logic that's specific to cover mode is skipped — Custom Art has no bleed.
- The resulting PDF is exactly the canvas at native resolution, which PDF.js converts to JPEG cleanly.

### PDF print
- Same `Print / Save PDF` path. Page size = canvas size in inches.

---

## Phased delivery

### Phase A — Editor (foundation)
**Changes**
- `state.customArt` default object.
- `state.layers` accepts `target: 'canvas'`.
- New `customArtPayload()` function.
- `normalizeTemplateMode` recognizes `customart`.
- New body class `template-customart` toggled by `syncInputs`.
- New `customArtFieldset` HTML with preset dropdown, width/height number inputs, background color picker.
- Wire size inputs to update `state.customArt`, re-render canvas.
- Layout-mode tab `mode-customart` added; clicking sets `templateMode = 'customart'`.
- Render the canvas: a div sized to `(width/96, height/96)` in inches with `position:relative; background:<fill>`, with `#layerOverlay` inside.
- `targetBounds('canvas')` returns `{x:0, y:0, w:wIn, h:hIn}`.
- `updateLayerTargetOptions` adds `Canvas` for customart mode.
- Save / load JSON round-trip.

**Acceptance**
- Switch to Custom Art tab → blank white canvas at default 1920×1080 visible.
- Change preset to 1:1 square → canvas reflows.
- Pick Custom and enter 600×900 → canvas reflows.
- Add a text layer + color layer → render and reposition them.
- Save project JSON → reload → state restored.

### Phase B — Publish & share
**Changes**
- Publish flow: `publishCurrentTemplateToNostr` adds branch for customart mode; uses `casewrap-customart` type tag, `customart:` d-tag prefix.
- `previewFromPayload` handles customart (returns first-image-layer src if any; otherwise empty).
- `templateEventDValue` / `templateEventAddress` already handle the d-tag tail.
- `shareIdForRow` works as-is (the existing prefix-aware naddr/nevent branching handles new modes).

**Acceptance**
- Publish a Custom Art design → fetch from another browser → it loads and renders.
- Share link round-trips: copy share URL → paste in new tab → opens the preview.

### Phase C — Template browser
**Changes**
- Type filter gains `Custom art` option in both `feedTypeFilter` rows and `welcomeType`.
- New "Size" filter dropdown appears when `Custom Art` or `Any` is selected.
- `buildRowsFromEvents` reads `payload.customArt` for aspect-ratio bucketing.
- New `renderCustomArtPreviewDOM(container, payload, opts)`.
- `openDesignPreview` adds dispatch for `mode === 'customart'`.
- Mini-preview cards: `buildFeedCard` dispatches to the new renderer in compact mode.
- JPEG export: `exportArtboardAsJpeg` and the print modal handle customart by sizing `@page` to canvas dimensions (no trim crop).

**Acceptance**
- Browse community → "Custom art" filter shows only customart designs.
- Aspect-ratio filter narrows to 16:9 etc.
- Each card mini-preview shows the canvas at its native aspect ratio (16:9 cards are wider than they are tall in the grid; portrait designs are letterboxed in the square thumb like the other modes).
- Clicking a card opens the full preview at the canvas's natural aspect.
- Export JPEG produces a flat 1920×1080 (or whatever) JPEG with the design's contents.

---

## Risks / tradeoffs

| Risk | Mitigation |
|---|---|
| Memory / perf on 8K canvases with many layers | Hard-cap dimensions at 8192×8192; document recommendation to stay under 4K for portability. |
| User confusion between pixel-input and inch-stored layer positions | Surface pixels in UI; conversion is hidden. Layer position inputs in inches stay (consistent with other modes); could expose px alternative in a future polish pass. |
| Cover-mode JPEG export pipeline assumed trim-area cropping | Custom Art skips the bleed-trim logic; export pdf at exact canvas size with `@page size: <w>in <h>in; margin:0`. |
| Type-filter UI gets cluttered with "Size" | The size filter only renders when relevant (customart selected or "any"). |
| Custom Art designs cluttering the cover/disc-focused community feed | The "Type" filter already exists; users can ignore Custom Art if they want. Consider a future "default type filter" preference. |
| Existing rendered preview math assumes inches | Phase B / C work all goes through the same helpers — inch-based internally means no rewrites. |
| Storage bloat (a published 4K design with embedded data URLs gets huge) | Layers continue to store URLs by default; users who want to embed bytes can use the planned future "cache at insert" path, separate from this feature. |
| 8192×8192 canvases break JPEG export (browser canvas limits ~16M pixels) | Documented limit; lower the max to 4096 if browser support proves shaky. |
| D-tag collision risk after publish-d-tag-prefix change | New d-tag has `customart:` prefix, distinct from all other content types. Same protection as `cover:` / `disc:`. |
| Layer targeting in disc/cover modes accidentally bleeds into Custom Art if same target name | Custom Art uses `canvas` target, no other mode uses it; isolation is clean. |

---

## Out of scope / future enhancements

- Pixel-native layer position inputs in the right panel (alongside the current inch-based inputs) for users who think in pixels.
- Background image (rather than solid color).
- Shape primitives (drawn rectangle, circle, line, arrow) as new layer types.
- "Starter" templates / preset compositions (e.g., "Instagram post template").
- Multi-frame / animated export.
- Vector layers / SVG export.
- Native pixel-art mode with snap-to-grid.
- Print-targeted custom art with bleed / trim controls.
- Browser-side downscale options for export (e.g., "Export at 50%").
- Crop / trim tool on the canvas itself.

---

## Implementation order

Start with **Phase A** end-to-end, including JSON save/load. Once the editor works, **Phase B** (Nostr publish + share-link round-trip) is mostly hooking into existing flows. **Phase C** (browser filter + size filter + mini-preview + export) is the last piece, after which the feature is shippable.

Each phase ends with a commit that's testable on its own. The user gets value from each chunk independently — Phase A alone lets you make and save Custom Art designs locally, even before they can be shared on Nostr.
