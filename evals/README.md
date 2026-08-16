# evals/

The golden set. 1,000 cases from `SuperTwinV11_GoldenEvals_V2.md`, one JSON
fixture each, run by the harness in `worker/src/evals/`.

```
evals/
  fixtures/              1,000 stubs, one per row of the doc's §5 case tables
  selftest/              10 hand-written fixtures, one per assertion mode
  generate-fixtures.mjs  regenerates fixtures/ from the doc
```

## Running

```sh
npm run eval                              # frozen mode, all 1,000, offline
npm run eval -- --measured                # hide gates nothing measured
npm run eval -- --only M,N                # one or more categories
npm run eval -- --dir evals/selftest      # the harness self-test
npm run eval -- --live --live-module ./x  # re-measure the gates on a real model
npm run eval:fixtures                     # regenerate from the doc
node evals/generate-fixtures.mjs --check  # fail if fixtures drifted from the doc
```

Exit codes: `0` clean · `1` a case failed or an architecture §14.2 gate was
breached · `2` a fixture did not validate or coverage is short of evals §4 ·
`3` the run could not be set up.

**Frozen mode makes no network call.** The CLI replaces `fetch`, `net.connect`,
`tls.connect` and `http(s).request` with throwing stubs for the duration of the
run, so an executor that reaches for the network fails its case instead of
quietly going online.

## Fixture schema

Exactly evals doc §2, validated on every read by `worker/src/evals/fixtures.ts`.
Unknown keys, a bad roster entry, a duplicate event number, an assertion mode
outside §3 or a `gate` that is not a row of architecture §14.2 all fail the load,
with every problem in the file reported at once.

Two additions the doc's example does not show: `assert.bound` (a `budget`
assertion needs its bound somewhere) and `stub`/`doc` on generated fixtures.

## Stubs and the executor seam

A fixture runs when two things exist: a payload (`given.events`,
`frozen_response`, `expect`) and an *executor* registered for its layer — the
product code that turns a model verdict into claims, loops, sessions and so on.
`registerExecutor("claims", fn)` in `worker/src/evals/executors/` from the item
that builds that layer, and its category starts scoring.

Registered today (`worker/src/evals/executors/index.ts`):

| layer | category | product code it drives |
|---|---|---|
| `wire` | S (50) | the real STW-2 codec, `worker/src/wire` |
| `accounting` | U (15) | `db/run-accounting`, `providers/usage`, `providers/pool` |
| `calib` | V (15) | `retrieval/calibration*`, `db/calib` |
| `harness` | — | the self-test format, `evals/selftest/` only |

Every other fixture is still a **stub**: it carries the doc row's identity and
text but no payload, and reports **PENDING**, never PASS.

A layer with no executor is PENDING and a gate with no measurement is `no data`.
Neither is ever reported as a pass — a suite that asserted nothing has proven
nothing.

## Who owns which half of a fixture

`generate-fixtures.mjs` owns the identity half of every fixture and nothing
else:

| doc-owned (regenerated) | authored (preserved) |
|---|---|
| `id` `category` `layer` `call` `mode` `doc` | `given` `frozen_response` `expect` `assert` `stub` |

A fixture that still says `stub: true` is wholly generated and must stay
byte-identical to what the script emits, so an untouched row cannot drift. A
fixture that says `stub: false` has been filled in: re-running the generator
re-stamps its doc-owned half and leaves the payload alone, and `--check`
compares only that half. Both halves are still validated by the loader.

Two executor conventions worth knowing when writing a payload:

* the `[CODE]` layers (`accounting`, `calib`) read `frozen_response` as a frozen
  **scenario** — one `tag|key=value|…` record per line — because there is no
  model verdict to freeze; and
* a wire response may carry a repair round after a line reading `#REPAIR`.
