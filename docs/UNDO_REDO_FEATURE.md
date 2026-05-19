# Undo / Redo Feature Plan (v2)

## Goals
Give every editor surface a familiar undo/redo flow so users can fix mistakes without leaving the editor.

### Product goals
1. `Ctrl+Z` / `Ctrl+Shift+Z` (and the equivalent macOS keys) feel natural everywhere in the editor.
2. Reverse any user-driven edit to **local design state** — adding / deleting layers, dragging, resizing, color changes, mode switches, artwork loads, metadata edits.
3. Do NOT undo network actions (publish, block, follow, tip), identity changes, or community-modal state — those are out-of-scope and irreversible.

### Non-goals
- Persisting the undo stack to localStorage (see "Storage strategy" — memory-only in v1).
- Selective undo of a specific past action.
- Time-travel / branched history.
- Multi-tab synced undo.
- Sub-action granularity inside text editing (text input already has the browser's native undo when focused).

---

## What snapshot includes

A snapshot is a deep-cloned subset of `state`. The fields are split into editor-state (snapshotted) and ambient/community state (not snapshotted).

### Snapshotted (editor state)
- `appMode` (`'template' | 'designer'`)
- `templateMode` (`'cover' | 'disc' | 'jewel' | 'customart'`)
- `savedMetaByMode` (the parked metadata for the other app mode)
- `meta` (title, identifiers, customTag, category, language, omdbApiKey)
- `preset`, `panelW`, `trimH`, `spineW`, `bleed`, `safe`, `artworkMode` (cover-mode dimensions + wrap mode)
- `slots`, `combined` (cover artwork)
- `discs`, `discMeta`, `discSpineLabels` (disc-sheet artwork + per-disc metadata + spine labels)
- `jewelInserts`, `jewelSpineLabels` (jewel artwork + spine labels)
- `customArt` (canvas width, height, background, preset)
- `discDesign` (single-disc-designer state)
- `layers` (the entire layer array, including per-layer fill / stroke / clip / shape data)
- `selectedLayerId` (so undoing restores the active selection)
- `editingDTag`, `editingKind`, `editingEventId`, `editingTitle` (edit-in-place context — yes, snapshot, so cancelling out of edit mode and undoing brings the context back)
- `showGuides`, `showBleed`, `showCrops`, `printGuides`, `printCrops`, `zoom` (display toggles — debatable, but cheap to include so users can undo "I turned off crops")

### NOT snapshotted (ambient / community / cache)
- `community.*` (signed-in identity, follows, mute list, profile cache, relay list, etc.)
- `_feedCache`, `_zapCache`, `_profilePages`, `_blockedAuthors`, `_brokenImages` set
- `_layerClipboard` (clipboard is its own session ring buffer)
- `_publishConfirmTarget`, `_shapePathTarget`, `_tipTarget`, `_closeProjectTarget` (transient modal state)
- `_modalZTop`, `_aspectLocked` (UI preferences)
- `_discImportTargetSlot`, `_prevTemplateMode` (transient bookkeeping)
- `darkMode` (a user preference, not a design choice)

### Cloning strategy
Use `structuredClone(snapshot)` for both push and restore. Falls back to `JSON.parse(JSON.stringify(...))` if `structuredClone` is somehow unavailable. Both are fast for our state size (~30–500 KB per snapshot depending on layer count). No prototype chain to preserve, no Maps/Sets to lose.

---

## When to push a snapshot

Pushes happen on **coarse, completed edits**, not on every keystroke or slider tick. The list:

### Layer lifecycle
- `addImageLayer` / `addTextLayer` / `addColorLayer` / `addShapeLayer` succeed → push.
- Delete layer → push (before deletion so undo restores the layer).
- Duplicate layer → push.
- Paste / Paste all from the clipboard → push (after the paste lands).
- Cut → push (before removing, so undo restores it).

### Layer geometry / transforms
- Drag end (`pointerup` on a layer wrapper after a drag) → push **once** per drag, not per pointer-move.
- W / H / X / Y / Rotate / Opacity number inputs → debounced 400 ms after last `input` event.
- Aspect-lock toggle does NOT trigger a snapshot (it's a UI preference).

### Layer paint properties
- Color picker `change` event (the commit, not the live `input` drag) → push.
- Linear / radial gradient angle / center / radius sliders → debounced 400 ms.
- Stroke type, width, dash → debounced 300 ms for width; immediate for type / dash dropdowns.
- Shape kind-specific params (corner radius, sides, star points + inner ratio, line stroke width) → debounced 400 ms.

### SVG layer (`type:'svg'`)
- Per-element fill / stroke color picker `change` → push per element.
- Per-element stroke-width input → debounced 400 ms.
- Replace SVG (upload) → push immediately after the new SVG is parsed and applied.

### Clip / mask
- Clip kind dropdown change → push.
- Inline-shape clip param inputs → debounced 400 ms.
- Layer-ref clip target change → push.

### Mode / structural
- App mode flip (`switchAppMode('template' | 'designer')`) → push **before** the swap so undo returns to the previous mode + its parked metadata.
- Template sub-mode flip (cover/disc/jewel/customart) → push before the change.
- Close project / Clear images → push **before** the wipe so undo restores everything.
- Load project from file → push before the load.
- Fork (load row payload into editor) → push before the load.
- Edit-in-place enter / Cancel edit → push (the editing context is part of state).

### Artwork loads
- Slot artwork URL committed (cover front/spine/back, disc top/bottom, jewel front/tray, combined wrap, disc-designer image) → push.

### Metadata
- Title / IMDb / UPC / TheTVDB / MusicBrainz / Custom tag inputs → debounced 600 ms.
- Category / language `change` → push.
- Spine label inputs → debounced 600 ms.

### Custom Art canvas
- Canvas size preset change → push.
- Custom width / height inputs → debounced 400 ms.
- Background color picker `change` → push.

### NOT a snapshot trigger
- Selection (`selectedLayerId` only) — selection is reflected in snapshots but selection-only changes don't push.
- Layer reorder (Move forward / Move back) — debatable; v1 says **yes** push.
- Modal opens / closes.
- Community-feed tab switches, scrolling, filter changes.
- Hover, zoom, pan.
- Layer lock toggle (debatable — push to be safe).

---

## How undo / redo behave

```
pushHistory(label)
  ├── deep-clone the snapshotted slice of state
  ├── undoStack.push({ label, snapshot, at: Date.now() })
  ├── trim undoStack to UNDO_MAX entries
  └── clear redoStack

undo()
  └── if undoStack.length > 0:
        current = current snapshotted slice
        redoStack.push({ label: 'redo→' + …, snapshot: current })
        restore from undoStack.pop()
        rerender + sync inputs + paint banners

redo()
  └── mirror operation
```

`UNDO_MAX = 50` for v1. In-memory only — see Storage below.

### Restoring a snapshot
Restoration replaces the snapshotted fields on `state` and re-runs the sync/render pipeline:
1. `Object.assign(state, snapshot)` (or per-field assignment for the snapshotted set).
2. Re-derive any computed-after-restore state (we don't have much — `normalizeDiscState`, `normalizeJewelState`, `paintEditingBanner`, `applyTargetMode` on the active target, etc.).
3. Call `syncInputs()` + `syncAllSlotInputs()` + `syncAllDiscInputs()` + `syncAllJewelInputs()` + `syncCombinedInputs()` + `syncDesignerInputs()` + `syncModeTabsUI()`.
4. Call `render()`.

If the snapshot's `appMode` differs from the current `appMode`, the mode tabs UI flips along with the rest.

---

## Keyboard shortcuts

- `Ctrl+Z` / `Cmd+Z` → undo.
- `Ctrl+Shift+Z` / `Cmd+Shift+Z` → redo. Also accept `Ctrl+Y` (Windows muscle memory).
- **Bypass when an input is focused**: if `document.activeElement` is an `<input>`, `<textarea>`, or `[contenteditable]`, do nothing — let the browser's native text-input undo handle it. Same for the rich text layer editor.
- Capture on document-level keydown, not on a specific element, so it works regardless of focus when no input is active.

## UI surface

- Two small buttons in the editor's topbar: **Undo** and **Redo** with the ↺ / ↻ glyphs and shortcut hints in their `title=` attributes.
- Both buttons disable when their respective stack is empty.
- No toast on undo (would be noisy); the visual state change is feedback enough.
- The most-recent snapshot's label is shown in the button title (`Undo: add shape`) so users get a hint of what they'll lose.

---

## Storage strategy

**Memory-only for v1.** The existing doc proposed `localStorage`, but practical concerns:

- A 50-entry stack at 100 KB per snapshot is 5 MB, which is near localStorage's 5–10 MB cap for many browsers. With layers carrying gradient stops, sanitized SVG inner content, and 100+ designs cross-mode, the quota could be exceeded.
- We'd have to serialize on every push (~5–20 ms for big states), and JSON serialize/deserialize introduces no real benefit if we already have the live object.
- Surviving a reload is rare — users typically commit to either a save-to-file or a publish-to-Nostr at session end.

If we want reload-survival later (v2), use IndexedDB and store only the **last 10–15 snapshots** rather than the full stack. That's its own design exercise.

---

## Edge cases worth thinking about ahead of time

| Edge case | Plan |
|---|---|
| Drag in progress, user hits Ctrl+Z | Ignore — there's no committed snapshot to restore until pointerup. |
| Layer was selected, undo restores a state where that layer didn't exist | `selectedLayerId` is part of the snapshot, so this resolves naturally; if the layer no longer exists in current state, selection clears. |
| Undo mid-drag of layer wrapper | Same as above. We push on pointerup, not pointerdown. |
| User switches modes mid-undo | Snapshot's `appMode` flips back; the mode tabs UI reflects the change. |
| User edits a published design, undoes the edit | Restores the previous state including editing context. The actual Nostr event stays untouched until they republish. |
| Hot-key collision with a focused input's native undo | We bail out when active element is an input / textarea / contenteditable. |
| Snapshot during fork-load | Push **before** the load so undo returns to the pre-fork state. |
| Color picker fires many `input` events as user drags hue | Use the `change` event (commit), not `input` (live). For color pickers without a discrete commit, debounce 400 ms. |
| User Cuts then immediately Undoes | Restores the cut layer. Clipboard contents are NOT rolled back — the cut item stays in the clipboard available for paste. |
| Memory pressure with 100+ layer designs | 50-entry cap, snapshot diff size logged in dev for tuning. |
| Snapshot when undo / redo themselves are running | Guard with an `_isRestoring` flag so internal renders during restore don't push new snapshots. |

---

## Implementation slices

### Slice 1 — Core stack + restore
- `pushHistory(label)`, `undo()`, `redo()`, `_isRestoring` flag.
- Snapshot capture / clone / restore.
- The list of snapshotted fields.
- Wire `Ctrl+Z` / `Ctrl+Shift+Z` keyboard handler with input-focus bypass.
- Add Undo / Redo buttons in the editor topbar.
- Run-time disable when stacks are empty.

### Slice 2 — Wire push sites (the big slice)
- Layer add / delete / duplicate / paste / cut.
- Drag-end pointerup.
- All commit-style input handlers (`change` events on selects and color pickers, debounced `input` events on number / text / range inputs).
- Mode switches (app + template).
- Project load / fork / close.

### Slice 3 — Vector-shape-specific wiring
- Shape kind change.
- Fill type change / fill color / gradient stops / angle / center / radius.
- Stroke type / color / width / dash.
- Per-shape-kind params (corner radius, sides, star points, etc.).
- SVG element fill / stroke / stroke-width per-element edits (debounced).
- Clip kind / clip-shape params / clip layer-ref.

### Slice 4 — Polish
- Snapshot-label hints in button titles ("Undo: add shape", "Redo: change fill").
- Optional: snapshot-merging within a debounce window so rapid edits of the same field don't produce 10 history entries (already partially handled by per-key debouncers).
- Optional: a tiny "X" affordance to clear the history (useful when something unrecoverable happens and the stack gets junk).

---

## Acceptance

- [ ] Add a layer, drag it, change its color, then Ctrl+Z three times → empty canvas again.
- [ ] After three undos, Ctrl+Shift+Z three times → layer back at its colored, dragged final state.
- [ ] Switch to Disc Designer, draw something, switch back to Template, then Ctrl+Z → editor returns to Disc Designer with the work intact (per-mode-meta swap survives).
- [ ] Cut a layer, undo → layer restored; clipboard still holds the cut copy for paste.
- [ ] Open an existing project, change its title, undo → title reverts to the loaded value.
- [ ] Edit a published design (load via Edit), make changes, undo → state returns to the loaded version (still in edit mode).
- [ ] Cancel edit mode, undo → edit-in-place context restored.
- [ ] Load a project from disk in Disc Designer, undo → returns to the previous Template-mode state.
- [ ] Focus on the Title text input and press Ctrl+Z → browser's native text-input undo runs, our undo does NOT fire.
- [ ] Hit Ctrl+Z 60 times → only the last 50 changes roll back; older edits are gone (UNDO_MAX cap).
- [ ] Stack survives modal opens/closes, community-feed browsing, profile-page visits.
- [ ] Stack is cleared on full page reload (memory-only in v1).

---

## Risks / open questions

1. **Per-keystroke debouncing windows** — 400 ms is a reasonable default for sliders/numbers, 600 ms for text inputs. The risk is that very fast users would lose intermediate edits. Tuneable later.
2. **Drag granularity** — should I be able to undo a drag in 10-pixel increments, or just the whole drag? V1: whole drag. Less noise.
3. **Should "Replace SVG" (a destructive operation that loses per-element edits) push a snapshot or warn?** V1: snapshot, so undo restores the previous SVG content.
4. **Should the layer clipboard get its own history?** No. It's a single-slot ring buffer; cut → paste is a single forward action. Undoing a paste restores the pre-paste state but doesn't pop the clipboard.
5. **Selection-only undo?** No. Selection changes are not pushed.
6. **Cross-mode meta swap** — already covered by including `savedMetaByMode` in the snapshot. Tested via acceptance criterion above.
7. **Undo after Publish?** Publishing doesn't change snapshotted state, so undo has nothing to do.
8. **Undo after Delete + Publish-deletion (tombstone)?** Delete pushes a snapshot of the editor state (so undo restores local state). The Nostr tombstone is separate and not reversible.
