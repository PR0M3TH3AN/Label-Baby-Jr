# Color Fill Layers + Text Font Family Picker

## Goals
Expand the layer system with **two complementary additions**:

1. A new `color` layer type — a solid-color rectangle, useful as a tint, background, or accent block.
2. A **font family picker** on existing `text` layers so creators aren't locked into the browser default.

### Product goals
1. Add visual range without adding a new editor surface — both changes live in the existing layer panel.
2. Stay print-safe: no network-dependent fonts in v1.
3. No migration burden on existing payloads.

### Non-goals (v1)
- Gradient or pattern fills (color layers are flat fill only).
- Strokes / borders on color layers.
- Google Fonts or any web-fetched fonts.
- Per-character font styling (text layer is one font for the whole block, same as today).
- Drop shadows, blur, or other effects.

---

## Current state

### Existing layer types
| Type | Fields beyond standard | Where rendered |
|---|---|---|
| `image` | `src`, `fit?` | main canvas, cover preview, disc-sheet preview, jewel preview, disc-design preview |
| `text` | `html`, `fontSize`, `color`, `align`, `bold`, `italic` | same 5 places |

Standard fields shared by every layer: `id`, `type`, `name`, `target`, `x`, `y`, `w`, `h`, `rotate`, `opacity`, `z`.

### Existing UI structure
- **Per-target panels** (`renderLayerList`): one collapsible panel per region (page / cover-trim / back / spine / front / disc-top / disc-bottom / jewel-front / jewel-tray / designer-disc). Each has an "Add image" URL input and an "Add text" button.
- **Selected-layer controls** (`#layerControls`): one shared `<details>` block that conditionally shows `#layerImageControls` for image layers and `#textLayerControls` for text layers via display:block/none.
- **Renderers** in 5 locations:
  - `renderLayers()` — main editor canvas
  - `renderTemplatePreviewDOM()` — cover preview in the template browser
  - `renderDiscSheetPreviewDOM()` — disc sheet preview
  - `renderJewelPreviewDOM()` — jewel preview
  - `renderDiscPreviewDOM()` — disc-design preview

Each renderer has the same `if (layer.type === 'text') { … } else if (layer.type === 'image' && layer.src) { … }` shape.

---

## Color layer

### Data model
```js
{
  id: 'layer-…',
  type: 'color',
  name: 'Color block',
  target: '<target key>',
  color: '#3b82f6',     // hex string, accent blue default
  x, y, w, h,           // inches, same as image/text
  rotate: 0,
  opacity: 0.6,         // default less than 1 so it reads as a tint
  z: <nextLayerZ()>
}
```

### `addColorLayer(targetOverride)` helper
Sits next to `addImageLayer` / `addTextLayer` in the script. Same pattern:
- Resolve target from override or current `#layerTarget` value.
- Get `bounds = targetBounds(target)`.
- Insert centered, 70%×70% of the target bounds (same as image/text default sizing).

### Add-button placement
Inside `renderLayerList`'s per-target panel, alongside the existing Add image / Add text controls. Markup roughly:
```
[ image url input ] [ + Image ]   [ + Text ]   [ + Color ]
```
Single inline button — no extra inputs needed at add time (color picker lives on the selected layer).

### Selected-layer controls
Add a third sub-panel to `#layerControls`:
```html
<div id="colorLayerControls" style="display:none">
  <label for="colorLayerFill">Fill color</label>
  <input id="colorLayerFill" type="color" />
</div>
```
Toggled in `updateSelectedLayerControls()` alongside the existing image/text panels.

The existing **opacity** input applies to all layer types, so users can fine-tune the tint there.

### Rendering
Each of the 5 render sites gets a new branch:
```js
} else if (layer.type === 'color') {
  el.style.background = layer.color || '#000';
}
```
Place after the `text` branch, before the `image` branch (or wherever it fits each renderer's existing structure).

The element already has `opacity`, `transform: rotate(…)`, position, and size set by the shared code. No extra work needed.

### Defaults (locked in)
- Default color: `#3b82f6` (accent blue — obviously visible against most artwork).
- Default opacity: `0.6` (reads as tint, not as a blocker).
- Selectable / draggable / resizable just like image and text layers.

---

## Text font family picker

### Data model
Add one field to existing text layers:
```js
{ … , fontFamily: 'Arial, sans-serif' }
```

Existing text layers without `fontFamily` continue rendering with the browser default (no migration).

### Font list (locked in, web-safe only)

| Label | CSS value |
|---|---|
| System default | `inherit` |
| Sans-serif (Arial) | `Arial, Helvetica, sans-serif` |
| Sans-serif (Helvetica) | `Helvetica, Arial, sans-serif` |
| Sans-serif (Verdana) | `Verdana, Geneva, sans-serif` |
| Sans-serif (Trebuchet) | `"Trebuchet MS", sans-serif` |
| Sans-serif (Tahoma) | `Tahoma, Geneva, sans-serif` |
| Sans-serif (Arial Black) | `"Arial Black", sans-serif` |
| Sans-serif (Impact) | `Impact, "Arial Narrow Bold", sans-serif` |
| Serif (Times) | `"Times New Roman", Times, serif` |
| Serif (Georgia) | `Georgia, serif` |
| Serif (Palatino) | `"Palatino Linotype", "Book Antiqua", Palatino, serif` |
| Monospace (Courier) | `"Courier New", Courier, monospace` |
| Monospace (Consolas) | `Consolas, "Courier New", monospace` |
| Cursive (Comic Sans) | `"Comic Sans MS", "Comic Sans", cursive` |
| Cursive (Brush Script) | `"Brush Script MT", cursive` |

Each `<option>` previews itself via `style="font-family: <its-own-value>"` so the dropdown is its own preview surface.

### UI placement
Inside the existing `#textLayerControls` block, before the existing text size input:
```html
<label for="textFontFamily">Font</label>
<select id="textFontFamily"><!-- options --></select>
```

### Wiring
- `syncSelectedLayerControls`: read `selectedLayer.fontFamily` into the select (default to `'inherit'`).
- Change handler: `updateSelectedLayer('fontFamily', e.target.value)` + `render()`.
- Renderers (5 places): when `layer.type === 'text'`, apply `el.style.fontFamily = layer.fontFamily || 'inherit'`. One line added per renderer.

### Print-safety rationale
All fonts are either built into the OS or universally fallback-mappable. No external network request → no FOIT/FOUT during print → reliable spacing and metrics in PDF output. A "missing font" outcome would silently fall back to a similar metric within the same generic family (`sans-serif`, `serif`, `monospace`, `cursive`).

---

## Backward compatibility

- Old text layers without `fontFamily`: render with browser default (effectively `inherit`). No data migration.
- Old payloads with only `image`/`text` types: unchanged. The new `color` type only exists in payloads explicitly published after this lands.
- Old clients receiving a payload that contains a `color` layer: skip it (their renderers don't match `type === 'color'`, so they fall through and render nothing). Not great but not catastrophic — the rest of the template still renders. A future shared schema-version bump could signal "this template uses color layers."

---

## Implementation slices

### Slice 1 — Color layer (data + add + render)
1. `addColorLayer(targetOverride)` helper.
2. Add "Color" button to per-target panel rows in `renderLayerList`.
3. Renderer branches in all 5 places.
4. `#colorLayerControls` block + show/hide wiring in `updateSelectedLayerControls`.
5. Color-picker input handler.

### Slice 2 — Font family picker for text
1. Build out the `<select id="textFontFamily">` markup (with self-previewing options).
2. Read state in `syncSelectedLayerControls`.
3. Change handler.
4. Apply `style.fontFamily` in the 5 renderers.

Slices are independent — could ship in either order or together.

---

## Acceptance

### Color layer
- "Color" button appears in each target panel (and only the ones valid for the current template mode).
- Clicking it adds a 70%×70% rectangle filled with `#3b82f6` at 60% opacity in the relevant region.
- Selecting it shows a color picker that updates the layer fill live.
- Position/size/rotation/opacity controls all work (same as image/text).
- Color layer round-trips through save/load and through publish/Nostr-import without data loss.
- Color layer renders in all 4 preview surfaces (cover, disc-sheet, jewel, disc-design) and in the main editor canvas.

### Font family picker
- Text-layer panel shows a "Font" dropdown with the locked-in list.
- Selecting a font updates the selected text layer instantly (and the dropdown's options visibly preview their own font).
- Saved/loaded text layers keep their font choice.
- Text layer renders with the chosen font in all 4 preview surfaces and the main canvas.
- Text layers from before this change render with the previous (default) font.

---

## Risks and tradeoffs

| Risk | Mitigation |
|---|---|
| Color block at 60% opacity could be mistaken for an image-loading state on first add | Distinct "MISSING IMAGE" badge is reserved for the broken-image case; new layers default to accent blue which is unmistakably solid color |
| Old clients see new `color` layers as no-ops | Acceptable for v1; bump schema version later if widespread |
| Picked font doesn't exist on the printer/viewer OS | CSS fallback chain ends in a generic family; visually similar metrics; acceptable for v1 |
| Color layer used as a full backdrop covers the artwork beneath | User controls opacity and z-order; same affordances as image layers |
| Font dropdown clutters the text controls panel | Single labeled select, collapsible if needed in a future polish pass |

---

## Out of scope / future enhancements

- Custom CSS `font-family` text input for power users.
- Gradient fills on color layers.
- Stroke/border on color layers (and image layers).
- Per-character or per-word formatting in text layers.
- Drop shadow / outline effects.
- Saved swatches / palette per project.
- Eyedropper to pick a color from the artwork beneath.
