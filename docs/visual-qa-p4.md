# Visual QA checklist — P4.2 (result renderer · modals · People view)

Filled in against the running components on 2026-08-29 (jsdom renders via the
P4.2 test suites `src/renderer.test.tsx` + `src/people.test.tsx`, plus a read
of the composed DOM/CSS). jsdom verifies structure, text, ARIA and class
wiring — it does NOT execute layout, `backdrop-filter`, fonts or real drag
imagery, so every item marked **human eye** needs a pass in the built app.

Legend: `[x]` verified at jsdom level · `[~]` partially verifiable · `[ ]`
needs a human eye in the real webview.

## Generative result renderer (spec §14.5)

- [x] All seven schemas render from `{result_type, data}`: comparison_table,
  itinerary, draft_preview, approval_card, research_brief, checklist,
  receipt (golden test per type).
- [x] The model composes data only — every color/spacing/layout decision is in
  the Kit* primitives / CSS; no style information is read from payloads.
- [x] Unknown `result_type` falls back to the clean document card (never raw
  JSON, never a blank region).
- [x] Missing fields render as absent, never crash (empty-payload tests).
- [x] Comparison tables sit in an `overflow-x` container so wide fare tables
  scroll instead of breaking the modal.
- [ ] **human eye**: table column rhythm, blockquote inset, and the muted
  `--ink-2` footnote contrast on the glass background.
- [ ] **human eye**: a long research_brief inside the task modal — does the
  live-result region scroll within the modal instead of growing past the
  viewport?

## Claim modal (spec §14.6)

- [x] Anatomy: title = claim text, kind chip, conf + validity window line
  ("conf 1.00 · valid Aug 2026 → open").
- [x] Supersede history renders ("replaced “coworker” — Aug 2026"); old
  versions carry validity ends, never vanish (FIX-03 surface).
- [x] Evidence quotes render ❝…❞ from the active version's evidence list.
- [x] `[Not true]` `[Outdated]` chips fire the structured claim corrections;
  the same two (and only those two) appear in the ··· sheet.
- [x] Esc / click-outside close via the shared ModalFrame scrim.
- [ ] **human eye**: history lines legible but visually subordinate to the
  active claim; chips look like buttons, not chips-as-labels.

## Person modal (spec §14.6)

- [x] Header: name · circle chip (⦿ label) · "provisional person" type chip.
- [x] Circle is changeable in place; the change posts
  `{type:"set_circle", circle}` — same pipeline as the People-view drag.
- [x] Claims list with first evidence quote per claim; empty state reads
  "no claims about them yet".
- [x] Tone line composed from the tone profile ("Hinglish, short, 🔥-heavy —
  used for drafts").
- [x] Provisional people show "no contact info — link a contact?".
- [x] Relationship edges render as the loops strip.
- [ ] **human eye**: the native `<select>` for the circle — acceptable glass
  styling, or does it need the custom dropdown treatment before ship?
- [ ] **human eye**: photo/avatar slot is not rendered yet (no image source
  in the world model) — confirm the ◙ glyph placeholder reads OK.

## Prepared-artifact modal (spec §14.6)

- [x] Anatomy: ◆/◇ per producer, title, kind + space chips, intent line
  ("Saw you comparing Anjuna villas — prepared this.").
- [x] Artifact body renders full-size through the SAME §14.5 renderer;
  non-envelope bodies get the document card; broken JSON degrades to the
  summary text.
- [x] Provenance line ("built from 3 sites + your budget claim (provenance →)").
- [x] Actions: `Make it a task` · `Iterate…` (context-locked bar thread via
  the artifact's space; hidden when unfiled) · `Discard` (kept, never
  deleted — parks in the panel's older drawer).
- [ ] **human eye**: artifact region sizing at "full size" vs the nudge peek.

## People view + circles (spec §7.3 / §14.4.1, CIR-04)

- [x] People grouped into the nine circles + "no circle yet"; provisional
  people chip-flagged; counts per group.
- [x] Drag between circle groups = correction: posts
  `{type:"set_circle", circle}` to /api/corrections; undo chip appears
  (drag-to-same-circle posts nothing).
- [x] Drop target highlights while dragging (`.drop-target` class toggles).
- [x] Open merge questions surface at the top of the view (served by the
  worker, never re-derived).
- [x] Click / Enter opens the Person modal.
- [x] Worker half (corrections-routes tests): mutation applied immediately,
  decisions row written, eval case auto-drafted, undo restores the old
  circle (CIR-04); `set_relationship` supersedes the old relationship claim
  with a validity end and moves the circle (FIX-03).
- [ ] **human eye**: drag affordance (cursor: grab, drag image) in the real
  webview — jsdom cannot exercise the native drag imagery.
- [ ] **human eye**: nine groups on one screen — does the column need to be
  two-up on wide windows?

## Cross-cutting

- [x] One modal system: every new modal is ModalFrame (or the shared scrim
  anatomy), Esc/click-outside close, footer = evidence · why? · ···.
- [x] ··· menu stays exactly three items everywhere; person "Remove" maps to
  the honest `stop_tracking` (recorded, never a delete).
- [x] Every correction path lands in POST /api/corrections and surfaces an
  undo chip when a decision row came back.
- [ ] **human eye**: modal-over-modal (Person modal opened from People while
  the undo toast is up) — z-order and scrim depth.
- [ ] **human eye**: liquid-glass materials (`backdrop-filter`, vibrancy) on
  all three new surfaces — jsdom cannot render them at all.
