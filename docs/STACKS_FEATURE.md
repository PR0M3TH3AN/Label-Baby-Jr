# Artstr Stacks — interactive fullscreen pages

## Goals

Turn Artstr into a Nostr-native **HyperCard**: a user builds a **stack**
of fullscreen **cards**, each one an Artstr canvas (layers, drawings,
text, images, shapes, QR), and any layer can be made **interactive** —
click it to jump to another card or open a link. The whole stack
publishes as one self-contained Nostr event and plays in a fullscreen
**interactive viewer**.

Think interactive zines, micro-sites, portfolios, album booklets, comics,
choose-your-path pages — all decentralized, forkable, no hosting.

### The core realisation

**A Stack is a Slide Deck with interactive layers.** The Deck Builder
already gives us ~70% of this — a Stack is not a greenfield feature, it's
a focused extension of `templateMode: 'deck'`. What's genuinely new is
*layer actions* and an *interactive (non-linear) viewer*.

### Product goals

1. **Stack format** — a Template-tab layout: an ordered set of fullscreen
   cards, each an Artstr canvas, at a stack-wide aspect ratio (16:9, 9:16,
   1:1, 4:3, or custom — not locked to 16:9 like slide decks).
2. **Interactive layers** — any layer can carry an `action`: jump to a
   card, or open a URL. Transparent **hotspot** layers make
   click-anywhere regions trivial.
3. **Interactive viewer** — a fullscreen runtime that renders a card and
   routes clicks on actionable layers. Non-linear: the stack decides where
   a click goes, not just next/prev.
4. **Nostr-native** — publish/fork/edit-in-place as a `kind:30078`
   addressable event, shareable by `naddr`, encryptable via the
   private-publishing envelope.

### Non-goals (v1)

- **Arbitrary HTML / CSS / JavaScript.** Stacks are a *safe declarative
  schema* Artstr renders — never executable web content. No iframes, no
  script, no custom CSS. This is the single most important constraint.
- **Forms, inputs, databases, server logic** — a stack is a presentation
  artifact, not an app.
- **Per-card transitions / animations** — future polish.
- **Blossom media upload** — v1 uses image URLs, like the rest of Artstr.
- **`zap`, `open-nostr`, `toggle-layer` actions** — namespace reserved,
  not built in v1 (`zap` alone drags in the whole Lightning flow).
- **Scrolling / multi-viewport cards** — a card is one fixed-size canvas.

### Decisions (proposed — confirm before building)

1. **New `templateMode: 'stack'`**, reusing the Deck Builder's
   card-container engine — *not* a flag on `deck`. A Stack and a Slide
   Deck are distinct products (free aspect + interactivity vs. locked
   16:9 + linear presenting), even though they share most code.
2. **v1 action set: `goto-card` and `open-url` only.** Everything else is
   reserved namespace.
3. **`open-url` shows a confirm** with the destination before navigating
   — a published stack is untrusted content.
4. **One event = one stack** (all cards embedded inline), exactly like a
   deck. Multi-event stacks are explicitly not v1.
5. Additive schema — `action` on layers, `id` on cards, a `stack` payload
   object. No `SCHEMA_VERSION` bump required.

---

## Why this fits the repo — what's reused

A Stack reuses the Deck Builder's **card-container engine** almost
wholesale. An `isDeckLike(mode)` helper covers both `'deck'` and
`'stack'`, so this plumbing is shared, not duplicated:

- **The card sorter** — the thumbnail grid, add / import / duplicate /
  delete / drag-reorder / inline-rename (`renderDeckSorter` and friends).
- **Edit round-trip** — open a card in the canvas editor, write back on
  switch (`persistEditingDeckSlide` pattern, `editingIndex`).
- **Inline-embedded storage** — one self-contained payload; the publish /
  load / fork path; `naddr` sharing; the community feed card with a
  count badge.
- **The whole canvas editor** — layers, text, shapes, the pen/pencil
  tools, clipping, undo/redo all apply to a card unchanged.
- **Encryption** — a stack payload is deck-shaped, so the
  `PRIVATE_PUBLISHING_FEATURE.md` envelope wraps it with zero extra work.
- **The fullscreen renderer** — Presenter Mode already renders a card
  full-screen, letterboxed, via `renderCustomArtPreviewDOM`. The
  interactive viewer is that runtime plus an action-routing overlay.

### Genuinely new work

1. A per-stack **aspect ratio** (decks are locked 16:9).
2. The **`action`** field on layers + the editor UI to set it.
3. Stable **card `id`s** (so `goto-card` survives reordering).
4. The **interactive viewer** — action hit-testing over the rendered card.
5. A public **viewer route** (`/p/<naddr>`).

### Current-state facts the plan is built on

- `templateMode: 'deck'` — embedded ordered cards, the sorter view,
  edit-a-card-in-the-canvas-editor with write-back, publish/fork as
  `casewrap-deck`, feed card with a count badge. (See
  `SLIDE_DECK_FEATURE.md`.)
- Presenter Mode (`#presenterMode`) — fullscreen, renders a card with
  `renderCustomArtPreviewDOM`, keyboard nav, an Audience (slide-only)
  view.
- Layer renderer positions every layer as an absolutely-placed div from
  inch coordinates; `renderCustomArtPreviewDOM` does the same at preview
  scale, with `pointer-events:none` on layers.
- `casewrap-*` typed `kind:30078` events; `/share/<naddr>` cold-resolves;
  `vercel.json` rewrites `/share/:id` and `/u/:npub` to the SPA.

---

## Data model

### Stack payload (`templateMode: 'stack'`)

```js
{
  version: SCHEMA_VERSION,
  templateMode: 'stack',
  templateType: 'stack',
  meta: { … },                       // title / category / language
  stack: {
    aspect: '16:9',                  // 16:9 | 9:16 | 1:1 | 4:3 | custom
    width: 1920, height: 1080,       // canvas size every card shares
    theme: { fontFamily: '', background: '' },   // same as deck.theme
    startCard: '<cardId>',           // entry card (default: first)
    cards: [
      {
        id: 'c_a1b2c3',              // stable; goto-card targets this
        name: 'Cover',               // optional label in the sorter
        background: '#111111',
        layers: [ … ],               // standard layers, may carry `action`
        ignoreStackTheme: false
      },
      …
    ]
  }
}
```

- A `card` is the deck's slide entry generalised: it gains a stable `id`,
  drops `notes`, and its `layers` may carry `action`s. Canvas dimensions
  live at the **stack** level (every card shares the aspect) rather than
  per-card — all cards in a stack are the same size.
- The deck's render-time theme composition (`composeSlideForDeck`) is
  reused as-is (`ignoreStackTheme` mirrors `ignoreDeckTheme`).

### The `action` on a layer

Any layer may carry an optional `action`:

```js
// Jump to another card — target is a card id or a keyword.
{ "action": { "type": "goto-card", "target": "c_a1b2c3" } }
{ "action": { "type": "goto-card", "target": "next" } }   // next|prev|first|last

// Open an external link.
{ "action": { "type": "open-url", "url": "https://example.com" } }
```

- `goto-card.target` is a **card id**, never an index — reordering or
  duplicating cards never breaks a link.
- A dangling target (the card was deleted) is a viewer no-op + a console
  warning; the editor flags it.
- Unknown `action.type` values are ignored by the viewer — forward-safe
  for the reserved set (`open-nostr`, `zap`, `toggle-layer`, …).

### Hotspots

No new layer type. A **hotspot** is just a shape (rect) layer that is
transparent — no fill, no stroke — carrying an `action`. The editor
offers an **"Add hotspot"** convenience that drops a transparent rect
ready for an action; otherwise any image / text / shape layer can be made
actionable.

### Nostr

- Tag `casewrap-stack`; `d`-tag `stack:<title|id>` (or a random `d`-tag
  when published privately, per `PRIVATE_PUBLISHING_FEATURE.md`).
- Forkable and editable-in-place via the existing NIP-33 flow.
- `naddr` shareable; encryptable.

---

## The surfaces

### 1. Stack Builder — the card sorter

The Deck Builder sorter, reused. A new **Stack** option in the Template-
tab Layout panel (beside Case cover / Disc labels / Slide deck). The
sidebar adds a **Stack** panel:

- **Aspect ratio** — 16:9 / 9:16 / 1:1 / 4:3 / custom. Chosen up front;
  changing it resizes every card's canvas (layers keep their inch
  positions; a warning notes some may need nudging).
- **Add card** (blank / import a design / import from Nostr), duplicate,
  delete, drag-reorder, inline-rename — all from the deck sorter.
- **Start card** — which card the viewer opens on (default: first).
- A **Stack theme** panel (font + background), reused from the deck.

### 2. Card editor + the Action control

Clicking a card opens it in the canvas editor (the deck edit round-trip,
unchanged). New in the **layer panel**: an **Interactivity** section for
the selected layer —

```
Interactivity
  Action:  [ None ▾ ]            None | Go to card | Open URL
  → Go to card:  [ Card ▾ ]      first | previous | next | last | <named card>
  → Open URL:    [ https://… ]
```

- Layers with an action get a badge in the layer list and a subtle dashed
  outline on the canvas, so interactive regions are visible while editing.
- An **"Add hotspot"** button drops a transparent, action-ready rect.
- A dangling `goto-card` target is flagged in the panel.

### 3. The interactive viewer

The fullscreen runtime, built on the Presenter Mode engine:

- Renders the current card full-screen, letterboxed to the stack aspect,
  themed (`composeSlideForDeck` reused), via `renderCustomArtPreviewDOM`.
- An **action overlay** sits above the card: for each layer with an
  `action`, a positioned, pointer-enabled hit region (matching the
  layer's box). A hovered actionable region shows a pointer cursor.
- **Click routing:** `goto-card` → navigate (resolving keywords /
  ids); `open-url` → a confirm dialog showing the destination, then open
  in a new tab.
- **Keyboard fallback** — arrows / space still do prev/next so a stack
  with no on-card navigation is never a dead end; `Esc` exits. The viewer
  owns the keyboard (capture-phase handler), like Presenter Mode.
- **History** — visited cards form a back-stack so a Back control / the
  Backspace key can return, even across `goto-card` jumps.
- Entry points: a ▶ **"View"** button in the Stack Builder tool palette,
  and an **"Open Stack"** button on a stack's community-browser preview.

### 4. Public viewer route

`/p/<naddr>` — a cold-loadable URL that resolves the addressable event
and boots straight into the interactive viewer (no editor chrome). Needs
a `vercel.json` rewrite (`/p/:id` → SPA), mirroring `/share/:id`.
`/share/<naddr>` of a stack continues to open the editor, as other
designs do.

### 5. Community feed

A published stack is a normal `kind:30078` event:

- **Feed-card thumbnail** — the start card's mini-render with a
  card-count badge (e.g. `8 cards`), reusing the deck preview renderer.
- **Publish-confirm preview** — likewise the start card.
- **Preview page** — carries the **Open Stack** button (surface 3).
- `stack` joins `MODE_LABELS`, the dedup fingerprint, the mode filters,
  and gets a `stack` ("Interactive page") category.

---

## Security

- **No executable content.** The schema is declarative; the viewer only
  ever interprets the two known action types and ignores the rest. No
  HTML injection, no script, no iframes, no remote CSS.
- **`open-url` is the one outward vector** — always route it through a
  confirm dialog that shows the real destination URL, and open with
  `rel="noopener noreferrer"` in a new tab. Never auto-navigate.
- **Image layers stay remote URLs**, as everywhere in Artstr — no binary
  embedded, payload size bounded to layer JSON.
- A stack imported / forked from the community is untrusted; the same
  rules apply when *editing* it (e.g. surface dangling/odd actions).

---

## Phased delivery

> **A + B + C together are the minimum genuinely-useful unit** — a stack
> with no actions and no viewer is just a free-aspect deck. Ship them as
> one arc, gated individually.

### Phase A — Stack format
- `templateMode: 'stack'` reusing the deck engine via `isDeckLike()`.
- The `stack` data model; per-stack aspect ratio (presets + custom).
- Stack option in the Template-tab Layout panel; the Stack + theme
  sidebar panels; the card sorter (add / import / duplicate / delete /
  reorder / rename).
- Stable card `id`s.
- Save / load / publish / fork as `casewrap-stack`; feed card + count
  badge; `stack` in `MODE_LABELS` / categories / mode filters.

**Ship gate:** build a 5-card 9:16 stack, reorder it, edit a card, save,
reload, publish — it round-trips and shows in the feed with its count.

### Phase B — Interactive layers
- The `action` field on layers; the layer-panel Interactivity control.
- "Add hotspot" convenience; actionable-layer badges + canvas outline.
- Dangling-target detection.

**Ship gate:** add a hotspot with a `goto-card` action and a button with
an `open-url` action; both persist through save / reload.

### Phase C — Interactive viewer
- The fullscreen viewer: action overlay, click routing, `open-url`
  confirm, keyboard fallback, visited-card back-stack.
- ▶ View entry point in the Stack Builder palette; Open Stack on the
  community preview.

**Ship gate:** play a stack end to end by clicking hotspots; `goto-card`
jumps and Back works; `open-url` confirms then opens.

### Phase D — Public viewer route + polish
- `/p/<naddr>` route + `vercel.json` rewrite; cold-boot into the viewer.
- Profile-page "feature this stack" pinning; share-link affordances.

### Later
- Blossom / NIP-B7 media upload.
- More actions: `open-nostr`, `zap`, `toggle-layer`.
- Card transitions; stack templates (zine / portfolio / comic / landing).
- Multi-event stacks (manifest + per-card events) for very large stacks.

---

## Risks & tradeoffs

| Risk | Mitigation |
|---|---|
| "Pages on Nostr" invites expectations of real websites (HTML/JS/SEO/hosting) | Name and frame it as *interactive stacks/pages*, not websites; the declarative-only schema is a hard line. |
| `open-url` is a phishing / malware vector in shared stacks | Mandatory confirm dialog showing the destination; new tab + `noopener`; never auto-navigate. |
| `goto-card` targets break on reorder / delete | Targets are stable card `id`s, never indices; dangling targets are editor-flagged and viewer no-ops. |
| A stack with only on-card navigation could trap the viewer | Keyboard prev/next + a back-stack + `Esc` always work, regardless of the stack's own buttons. |
| Aspect-ratio change strands existing layers off-canvas | Layers keep inch positions; the editor warns; the off-canvas veil already shows what's clipped. |
| Stack vs Deck duplication | One shared card-container engine via `isDeckLike()`; only aspect, actions, and the viewer branch. |
| Big stacks → large events (relay size caps) | Images are URLs; warn past ~100 KB / ~25 cards; Blossom offload + multi-event stacks deferred. |
| Layer click hit-testing under rotation / clipping | The action overlay uses the same box math as the renderer; rotated hotspots use the layer's transformed box; complex clip shapes hit-test on the bounding box (documented limitation). |

---

## Open questions

1. **Mode** — confirm `templateMode: 'stack'` reusing the deck engine,
   vs. folding actions + free aspect into `deck` itself.
2. **v1 action set** — `goto-card` + `open-url` only — confirmed?
3. **Aspect presets** — 16:9 / 9:16 / 1:1 / 4:3 / custom — the right set?
4. **Viewer** — extend the Presenter Mode runtime with an interactive
   mode, or a separate viewer module? (Lean: extend it.)
5. **Route** — `/p/<naddr>` as proposed, or a different prefix?
6. **Category** — one `stack` category, or split (e.g. `page`, `zine`)?

---

## Acceptance summary

### Phase A
- [ ] Stack is a Template-tab layout; per-stack aspect ratio works.
- [ ] Card sorter: add / import / duplicate / delete / reorder / rename;
      cards have stable ids.
- [ ] Save / load / publish / fork as `casewrap-stack`; feed card shows a
      card-count badge.

### Phase B
- [ ] Any layer can be given a `goto-card` or `open-url` action; a
      transparent hotspot can be added in one click.
- [ ] Actions round-trip through save / reload / publish; dangling
      `goto-card` targets are flagged.

### Phase C
- [ ] The interactive viewer renders cards full-screen and routes clicks
      on actionable layers.
- [ ] `goto-card` (ids + keywords) navigates; a back-stack + keyboard +
      `Esc` always work; `open-url` confirms then opens in a new tab.
- [ ] The viewer owns the keyboard; theme is composed in.

### Phase D
- [ ] `/p/<naddr>` cold-boots a published stack into the viewer.
