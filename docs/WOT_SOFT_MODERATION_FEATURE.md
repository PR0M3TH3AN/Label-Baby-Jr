# Web-of-Trust Soft Moderation (Blur-by-WoT)

## Goals
Use the signals already produced by Phase 2 (NIP-51 mute lists) and Phase 4 (NIP-56 reports) to **passively dim** community-feed cards that people the viewer trusts have flagged — without centralizing moderation or hard-hiding content.

### Product goals
1. Reduce the visual surface area of suspected spam / abuse for logged-in users.
2. Use only Nostr-native data already being published.
3. Stay non-censorial: every soft-moderated card is one click away from full view.
4. Cost no more than ~1 extra relay round-trip per feed load.

### Non-goals (v1)
- Replacing the personal block list. Soft moderation is *additive* to personal blocks.
- Cross-relay consensus or scoring servers.
- Soft moderation for logged-out users (no WoT to weight against).
- Hiding the author entirely (that is what Phase 1 block is for).
- Punishing the reporter (no "reporter reputation" yet).

---

## Problem statement
Phase 4 added the ability for any user to publish kind-1984 reports, but those reports currently have **no consumer in the UI**. The same is true of mute lists from people the viewer follows — Phase 2 syncs the viewer's own mute list but doesn't read anyone else's.

That means abuse signal already flowing through the relays is being thrown on the floor. Soft moderation closes that loop by turning the signal into a visual cue the viewer can act on.

---

## Data sources

| Signal | Kind | Author scope | Weight (v1) |
|---|---|---|---|
| Mute by a hop-1 follow | `10000` | viewer's hop-1 set | **1** |
| Report by a hop-1 follow | `1984` | viewer's hop-1 set | **1** (any reason) |
| Mute by a hop-2 follow | `10000` | viewer's hop-2 set | **0** (ignored in v1) |
| Mute/report by stranger | either | anyone else | **0** (ignored) |

Reports use the `reason` tag (`spam`, `nudity`, `illegal`, `impersonation`, `other`) — surfaced in the overlay label so the viewer sees *why*, not just *that*, the card was flagged.

### Why hop-1 only in v1
Hop-2 introduces too much noise and a real mob-blur risk: three coordinated strangers two hops away can dim a creator for thousands of people. Hop-1 means **someone the viewer personally trusts** has made a moderation decision. That's a much stronger signal and a much harder graph to game.

Hop-2 can be added later behind a setting if hop-1 alone proves too sparse.

---

## Threshold model (v1)

A card is soft-moderated when:

```
hop1_mutes(author) + hop1_reports(author OR event) >= SOFT_BLUR_THRESHOLD
```

Where:
- `hop1_mutes` = number of distinct hop-1 follows whose latest kind-10000 includes this author's pubkey in a `p` tag.
- `hop1_reports` = number of distinct hop-1 follows who have published a kind-1984 against this author or this specific event.
- `SOFT_BLUR_THRESHOLD = 2` (constant for v1, tunable later).

**Rationale for 2:**
- 1 is too aggressive — a single grudge can dim a creator.
- 3+ is too rare in practice for most users' follow graphs (who may follow 50–500 people, of whom only a handful are active moderators).
- 2 means "at least two people I trust independently flagged this," which is the lowest threshold that demonstrably isn't a one-person decision.

### What is NOT moderated
- Authors the viewer themselves follows (`row.trust === 'trusted'` or `'self'`) — never blurred regardless of score. Trust beats crowd signal.
- The viewer's own templates.
- Authors already in the viewer's personal block list — already hidden by Phase 1, so blur is moot.

---

## UX

### Default state (blurred card)
```
┌────────────────────────────────────┐
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  │  ← blurred thumbnail (CSS filter)
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  │
│                                    │
│    ⚠ Flagged by 3 people you      │
│        follow · spam               │
│                                    │
│       [ Show anyway ]              │
└────────────────────────────────────┘
   Untitled template
   Author · category
```

- **Thumbnail**: `filter: blur(14px) saturate(0.5);` — recognizable as content, not readable.
- **Title and author**: rendered normally below the thumbnail (so the viewer can decide based on author).
- **Overlay copy**: shows count + dominant reason. Dominant reason is the most-common `reason` tag among the hop-1 reports, falling back to "muted" if only mute-list signals are present.
- **Show button**: stops propagation, removes the blur class, persists for the session (see "Reveal persistence" below).

### Reveal persistence
- A revealed card stays revealed for the current modal session.
- Reload or close-and-reopen the Community modal → cards re-blur.
- No persistent "trust this card" affordance in v1. (Could be added later via a session/local key.)

### Settings
One new toggle under Community → Privacy:

```
[x] Soft-moderate by web of trust
    Blur cards that ≥2 people you follow have muted or reported.
    Only applies when signed in.
```

Default: **on** for logged-in users. Stored at `localStorage['casewrap:wot:softmod:enabled'] = '1' | '0'`.

### Logged-out behavior
- Toggle hidden.
- No soft moderation applied (no WoT to weight against).
- Personal block list (Phase 1) still works.

---

## Engineering notes

### Where it slots into the pipeline
```
buildRowsFromEvents
  └── row.trust = trustTierForPubkey(...)        ← already exists
  └── row.softMod = computeSoftMod(row)          ← NEW
        ├── if !state.community.myPubkey → null
        ├── if !softModEnabled → null
        ├── if row.trust === 'trusted' || 'self' → null
        ├── if _blockedAuthors.has(...) → never reaches here (filtered earlier)
        └── return { score, reason, count } | null
```

`buildFeedCard` reads `row.softMod` and toggles a `.feedCardBlurred` class + injects the overlay HTML.

### Fetching the signal
Two new batched queries inside `fetchFeedAndReactions`, gated on `state.community.myFollows.length > 0`:

```javascript
// Hop-1 mute lists (latest kind-10000 per author)
queryRelays(relays, {
  kinds: [10000],
  authors: state.community.myFollows.slice(0, MAX_HOP1_FOR_SOFTMOD)
}, { timeoutMs: 3500, onEvent: onHop1MuteIncoming });

// Hop-1 reports (kind-1984 by anyone in hop-1, p-tagging any author in the feed)
queryRelays(relays, {
  kinds: [1984],
  authors: state.community.myFollows.slice(0, MAX_HOP1_FOR_SOFTMOD)
}, { timeoutMs: 3500, onEvent: onHop1ReportIncoming });
```

- `MAX_HOP1_FOR_SOFTMOD = 500` — same cap pattern as hop-2 follows.
- Both queries use the existing streaming `onEvent` callbacks so soft-mod state arrives progressively and `onProgress` re-renders pick it up.
- Results accumulate into a `Map<authorPubkey, { mutedBy: Set<reporterPubkey>, reportedBy: Map<reporterPubkey, reason>, eventReports: Map<eventId, Set<reporterPubkey>> }>` cached on `_feedCache.softMod`.
- For replaceable kind-10000, only the latest per author counts (handled by `created_at` desc + first-wins).

### Computing `row.softMod`
```javascript
function computeSoftMod(row) {
  if (!softModEnabled() || !state.community.myPubkey) return null;
  if (row.trust === 'self' || row.trust === 'trusted') return null;
  const authorBucket = _feedCache.softMod?.get(row.e?.pubkey);
  if (!authorBucket) return null;
  const mutedBy = authorBucket.mutedBy?.size || 0;
  const reportedBy = authorBucket.reportedBy?.size || 0;
  const eventReports = authorBucket.eventReports?.get(row.e?.id)?.size || 0;
  // Don't double-count: same reporter muting AND reporting = 1.
  const reporters = new Set([
    ...(authorBucket.mutedBy || []),
    ...(authorBucket.reportedBy?.keys() || []),
    ...(authorBucket.eventReports?.get(row.e?.id) || [])
  ]);
  if (reporters.size < SOFT_BLUR_THRESHOLD) return null;
  return { count: reporters.size, reason: dominantReason(authorBucket), reporters };
}
```

### Caching
- Soft-mod state is per-modal-session. Cleared when the Community modal closes.
- Hop-1 mute lists could be cached longer (15 min like hop-2 follows) but in v1 we re-fetch each modal open. Cheap enough.

---

## Phased delivery

### Phase A — Data fetch only (no UI)
- Add `MAX_HOP1_FOR_SOFTMOD`, `SOFT_BLUR_THRESHOLD` constants.
- Add `_feedCache.softMod` Map and aggregation logic.
- Add the two streaming queries inside `fetchFeedAndReactions`.
- Gate on `state.community.myFollows.length > 0`.

**Acceptance**: with a known-flagged author, `_feedCache.softMod.get(author).mutedBy.size` reads correctly in DevTools.

### Phase B — Card rendering
- Add `.feedCardBlurred` CSS (blur + saturate on `.feedCardThumb img`).
- Add `.feedCardSoftModOverlay` CSS (absolute-positioned label + "Show anyway" button).
- `buildFeedCard` checks `row.softMod` and applies the class + overlay.
- "Show anyway" button removes the class and stores the event id in a session `Set<string>`.

**Acceptance**: with a fixture (manually publish a kind-1984 from two test accounts the viewer follows against an author), the card renders blurred, count and reason match, "Show anyway" reveals it, and reload re-blurs.

### Phase C — Settings toggle
- Add the checkbox under Community → Privacy.
- Wire `softModEnabled()` to read `localStorage`, default `true`.
- Hide toggle when logged out.

**Acceptance**: toggling off immediately removes all blurs without reload; toggling on re-applies after the next `rerender`.

---

## Risks and tradeoffs

| Risk | Mitigation |
|---|---|
| Mob blur (small clique coordinates to dim a creator) | Threshold of 2 from *hop-1* — must be from people the viewer personally trusts, not strangers |
| False positives (someone mutes for personal beef, not policy) | Always one-click to reveal; never hide entirely; show count + reason so viewer can judge |
| Performance cost of extra hop-1 queries | Same streaming pipeline as templates; bounded by `MAX_HOP1_FOR_SOFTMOD = 500`; cacheable |
| Discoverability: revealed cards re-blur on reload | v1 trade-off for simplicity; v2 could add a per-event "trust this card" persisted set |
| Author follows the viewer's followers but they all mute that author | Unlikely in practice; if it happens, viewer can disable soft-mod or unfollow the muters |
| Reason tag missing or malformed on a kind-1984 | Skip that event for `dominantReason`; still count it toward `reporters.size` |
| Reporter compromise (someone gets phished, mutes everyone) | Threshold of ≥2 distinct reporters limits single-account damage |

---

## Out of scope / future enhancements

- **Reporter reputation**: weight reports from accounts the viewer follows more heavily, or downweight serial reporters.
- **Hop-2 expansion**: optional toggle to count hop-2 reports at a lower weight.
- **Reason-specific thresholds**: e.g., `illegal` triggers blur at count=1, `spam` requires count=3.
- **Persistent reveal**: per-event "I've decided this is fine" with `localStorage`.
- **Author-level overlay**: replace thumbnail blur with a full-card "Tap to expand" placeholder for severe categories.
- **Surface own reports**: "You and 2 others flagged this" feels different from "3 others flagged this".
- **Block-from-blur**: add a "Block author" button inside the overlay (currently the card's normal Block button does it).

---

## Open questions to resolve before build

1. **Should hop-1 mute counts include private mute lists?** NIP-51 supports encrypted `content` for private mutes — for v1 we only read public `p` tags.
2. **Should soft-mod re-fetch run on every modal open or only on first open per session?** Defaulting to every open for v1 — measure cost, downgrade to once-per-session if it hurts.
3. **Should the overlay show *who* (e.g., "Flagged by alice, bob")?** Probably not by default — turns moderation into social pressure. Leave as count + reason only.
4. **Does "Show anyway" persist across tab switches in the Community modal?** Yes — session-scoped, not tab-scoped.
