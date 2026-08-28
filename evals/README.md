# evals/

The V13 golden set — live-call, no frozen-response replay (build P0.9).

```
evals/
  v13/          175 fixtures materialized from the two eval docs:
                  94 from SuperTwinV13_GoldenEvals_V1.md (SEG skipped)
                  81 from SuperTwinV13_GoldenEvals_V2.md (BND replaces SEG)
                Re-emit after a doc edit: npm run eval -- --materialize
  v13/selftest/ 3 hand-written STB fixtures that prove the harness itself
                (stub pass + stub judge; zero model calls)
```

Each fixture is the V2 doc header's shape: `{ id, pass, mode, setup,
input_events, expected, wrong[], gates[] }`. `mode: "live"` cases run the real
pass (which runs the real `claude` CLI) and are graded by the haiku LLM judge
against `expected`, with `wrong[]` modes asserted by the judge plus code;
`mode: "code"` cases are asserted purely by code.

## Running

```sh
npm run eval                                    # the full golden set (live)
npm run eval -- --cat ROL,BND                   # selected categories
npm run eval -- --id ROL-01                     # one case
npm run eval -- --dir evals/v13/selftest --judge stub   # harness self-test
npm run eval -- --liveness                      # TRC-03 pass-liveness job
npm run eval -- --materialize                   # regenerate evals/v13 from the docs
```

Harness code: `worker/src/evals/` (fixtures/runner/judge/gates/report/liveness,
executors under `executors/`). BND executes through the scheduler's eval hook
(`worker/src/scheduler/eval-hooks.ts`, landed by P0.5); until that module
exports `runBndCase`, BND reports pending — never a false green.
