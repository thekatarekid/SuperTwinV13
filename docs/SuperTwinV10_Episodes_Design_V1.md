# Episodes — design in progress
**Status:** grooming. Nothing implemented. **§2 decisions confirmed 2026-08-13; §5 questions still open.** Wave 6 of the previous build doc was **stopped** because episodes as specified there could not replace the extraction unit; this document is the replacement.

**Decisions taken so far** are recorded in §2. **Open questions** are §5 — those block a build plan.

* * *
## 1. Why the original Wave 6 spec was stopped
Four structural findings from reading the real `engine.ts`:

1. **There are two units today, and an episode is neither.** Scheduling/durability runs on the **lane batch** — a _rowid window_ (`laneFetch`, `fitBatch`, `runNow`'s `{cursorStart, cursorEnd}`). What extraction _consumes_ is the `SpaceBucket` — one space × that space's slice of the window.
  
2. **Ordering is incompatible.** The cursor is **rowid**-ordered; an episode is **ts**-ordered. Backfilled history arrives with _higher_ rowids and _older_ timestamps, so an episode is never rowid-contiguous, and nothing can tell when a live episode has closed. `quarantined_batches.cursor_start/cursor_end`, the four lane cursors and reconcile's accounted-events rule are all keyed to that range.
  
3. **Assign clusters across chats**; a mechanical episode is inside one chat.
  
4. **Extract's 3-way parallelism is safe only because each call sees one space.** Two episodes routing to one space would race on its markdown.
  

None of this makes episodes wrong. It means **episodes are a second axis, not a replacement for the first** — and the phased plan below is built on that.

* * *
## 2. Decisions taken
### 2.1 Two distinct kinds of episode
|     | **Chunk** (mechanical) | **Arc** (topic) |
| --- | --- | --- |
| Boundary | Silence gap **+ size cap** | Model-judged topic |
| Scope | **One chat**, linked to a space | **Can span chats** when same topic |
| Continuity | **N trailing messages** repeated into the next chunk | **Carry-forward summary** of the previous arc |
| Reproducible | Yes — pure function of the data | No — needs a persisted decision (§5.2) |
| Phase | **1** | **2** |

_(Working names. "Chunk" and "arc" are used below only to keep them apart — rename freely.)_
### 2.2 Purpose: both, phased
- **Phase 1** — read-side grouping. Claims and tasks cite _"this conversation, Tue evening"_ rather than loose event ids. No change to how extraction batches. Works with the rowid cursor **untouched**.
  
- **Phase 2** — chunks become the unit **assign and extract** consume. Confirmed: "extraction" means **both stages**.
  

Each phase is independently useful and independently reversible.
### 2.3 Overlap
Raw overlap means the same message is read twice, so the **write gate must dedupe** the resulting claims and tasks.

> ⚠️ **Hard dependency.** The gate is currently mis-calibrated so badly that it merges _unrelated_ things (see `SuperTwinV10_LiveRunFindings_V1.md` §1 — 50 of 54 space comparisons resolved `same`). Overlap duplicates would appear to collapse correctly today, but for the wrong reason, and genuine content would keep being destroyed alongside them. **The gate recalibration must land before overlap is switched on**, or this feature will be validated against a broken oracle.

* * *
## 3. Phase 1 sketch — chunks, read-side only
- Mechanical bucketing: `GROUP BY channel_id ORDER BY ts`, cut on silence gap, force-cut at a size cap.
  
- Deterministic and idempotent: same events → same chunks, re-running creates nothing new.
  
- `claim_evidence.episode_id` **already exists and is nullable** (migration 0036, added deliberately so this wave would not need a second migration of the largest table).
  
- Link each chunk to a space. This is where the **≥95% space-link guard** from the original spec lives — and it is the number that killed V9G (83% unlinked, value evaporated).
  

**Honest risk on that guard:** 347 of 803 dispositioned events (43%) are `ignored`, and the dominant reasons — chit-chat, acknowledgment only, promotional broadcast — are **whole-session** phenomena. A chunk made entirely of ignored events has nothing to link to. The ≥95% guard as originally written is probably unreachable; it likely needs restating as _"≥95% of chunks_ **_containing at least one assigned event_**_"_.

* * *
## 4. Phase 2 sketch — chunks as the extraction unit
The hard part, and where §1's four findings bite. Rough shape:

- Chunks feed **assign**, which keeps its cross-chat clustering (a chunk is an input, not a constraint on the output).
  
- The rowid cursor stays the **durability** mechanism; chunk membership becomes an _attribute_ of events, not a replacement for the watermark.
  
- Extract stays **per-space** so the parallelism guarantee survives.
  

This is the part that needs the most design once §5 is answered.

* * *
## 5. Open questions — these block a build plan
### 5.1 What distinguishes an **arc** from a **space**? ⭐ most important
Both are cross-chat and topic-scoped. If they're the same thing, we don't need arcs — we need spaces to work, which is exactly what the live-run investigation says is broken.

My working assumption: **a space is the ongoing matter; an arc is one bounded episode of it.** "Apartment search" is a space; "the week we shortlisted three places in Indiranagar and lost two" is an arc. If that is right, an arc is roughly _a space × a time window_.
### 5.2 How do arcs stay replayable?
Model-judged boundaries mean the same events can bucket differently on a re-run, which breaks replay and makes bugs unreproducible — the reason the original doc forbade it.

Proposed: **persist the model's boundary decision** as a verdict row (same pattern as `gate_verdicts`), so a replay reuses the stored decision rather than re-judging. Acceptable?
### 5.3 Numbers
- **Silence gap** for a chunk boundary — 30 min? 60? 4 h? (WhatsApp conversation rhythm differs a lot between a group and a 1:1.)
  
- **Size cap** — in events, or characters/tokens? A cap in characters protects the prompt budget directly.
  
- **Overlap size** — 2, 3, 5 trailing messages?
  
### 5.4 Are arcs built **from** chunks, or independently from events?
Arc-over-chunks keeps one mechanical substrate and makes arcs a grouping layer. Arc-over-events is more flexible but means two independent bucketers over the same data.
### 5.5 Does an event belong to more than one chunk?
Overlap implies yes — a trailing message is in both chunk N and chunk N+1. Is `episode_events` therefore many-to-many with an `is_overlap` flag, so "which chunk owns this event" stays answerable for citation?
### 5.6 Do chunks apply to historical backfill, live messages, or both?
Backfill has complete sessions with known ends. Live conversation has an **open** trailing chunk that isn't finished yet. Does a live chunk get extracted immediately (and re-extracted as it grows), or only once it closes after the silence gap?
### 5.7 What does the user actually see?
Is either kind of episode a **UI surface** you'd browse, or purely internal machinery that shows up only as better citations on claims and tasks?

* * *
## 6. Decisions from the wider review that constrain this design (2026-08-13)
Recorded here because each one changes what episodes must do. Full context in `SuperTwinV10_LiveRunFindings_V1.md` §5–§6.

| Decision | Effect on episodes |
| --- | --- |
| Gate thresholds become **per-model, calibrated at startup** | Removes the blocker in §2.3. Overlap can only ship after this lands — otherwise duplicate collapse is validated against a broken oracle. |
| **Anchors default ON**, existing spaces backfilled | A chunk's space link should resolve through the `(anchor_kind, anchor_key, topic)` natural key **first**, not through similarity. This makes the ≥95% link guard far more reachable than it was. |
| A space needs **a goal OR a durable anchor** | Chunks must not manufacture spaces. A chunk whose events justify neither should link to no space rather than inventing one. |
| Merge policy: **improve, and keep every version** | Overlap re-reads a message, so the same claim will legitimately arrive twice. Under this policy the second arrival _enriches_ the claim and the earlier wording is retained as history — which is exactly the behaviour overlap needs. |
| **Nothing is final; re-derive existing spaces** | Chunk→space links must be re-computable, not write-once. Bucketing was already required to be deterministic and idempotent; this extends it to re-linking. |
| **Question cap removed** | An ambiguous chunk boundary, or a chunk that cannot be linked to a space, may now raise a question instead of guessing. |

* * *
## 7. Still open — these block a build plan
§5.1–§5.7 remain unanswered. In priority order:

1. **§5.1 — what distinguishes an arc from a space?** Both are cross-chat and topic-scoped. Working assumption: _a space is the ongoing matter, an arc is one bounded episode of it_ — "apartment search" is the space, "the week we shortlisted three places and lost two" is the arc. If that is wrong, the whole layering changes.
  
2. **§5.2 — how do arcs stay replayable?** Proposed: persist the model's boundary decision as a verdict row (the `gate_verdicts` pattern) so a replay reuses it rather than re-judging.
  
3. **§5.3 — the numbers.** Silence gap (30 min / 1 h / 4 h?), size cap (events or characters?), overlap size (2–5 messages?).
  
4. §5.4 — are arcs built _from_ chunks, or independently from events?
  
5. §5.5 — many-to-many `episode_events` with an `is_overlap` flag, so "which chunk owns this event" stays answerable for citation?
  
6. §5.6 — does a live, still-open chunk get extracted immediately and re-extracted as it grows, or only once the silence gap closes it?
  
7. §5.7 — is either kind of episode a UI surface, or purely internal machinery visible only as better citations?
