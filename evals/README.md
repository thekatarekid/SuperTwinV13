# evals/

The V13 golden set — live-call, no frozen-response replay (build P0.9).

```
evals/
  baseline/v13.json  the frozen per-category baseline (Build V6 Phase 1, S0.1).
                V2 categories (ROL, CIR, CHP, SCH, FUP, USR, FIX, TIM, TRC)
                are regression-gated against it: scoring below the recorded
                rate is a hard fail (GoldenEvals_V6_Phase1 §1.1, §3.1).
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
npm run eval -- --mode code                     # deterministic cases only (no judge needed)
npm run eval -- --baseline                      # print evals/baseline/v13.json
npm run eval -- --cat TIM --record-baseline --calls-log calls.log
                                                # run, then merge this run's per-category
                                                # tallies into the baseline file
```

## The baseline (`evals/baseline/v13.json`)

`--record-baseline` merges a run into the file: only the categories the run
actually selected are replaced, every other row is kept (or listed as
`not-run`), and the run itself — argv, git sha, case count, counted model
calls — is appended to `runs[]`. That is how the S0.1 baseline was produced
without paying for the whole set at once (a full live run is ~330+ `claude`
invocations): one `--mode code` pass (every deterministic fixture, 2 calls —
AST-02's deliberate evaluator probe), then live passes over exactly the
regression-gated V2 categories (`--cat CIR,TRC,ROL,TIM`, `--cat CHP,FUP`,
`--cat SCH,USR,FIX`; 66 calls). Categories that are not regression-gated
(TOP, ASN, CRE, CRI, CLM, TSK, CLS, CON, EXE, AGE) carry a `not-run` row
until someone pays for them.

Model calls are counted OUTSIDE the harness: point `CLAUDE_BIN` at a shim
that appends one line per invocation to a file and passes through to the real
CLI, then hand that file to `--calls-log`; the run records the line delta. Use
`--model-calls N` only when you already know the number.

Known-red rows recorded in the S0.1 baseline (the tree's truth, not a target):
`TIM-04` (backlog T7-5, Haiku fires early) and `SCH-01..03` — SCH-02/03 fail
because the fixtures carry absolute message dates (Aug 2026) that the policy
now rejects as "fire time already past" — the fixtures drift with the clock.

Harness code: `worker/src/evals/` (fixtures/runner/judge/gates/report/liveness,
executors under `executors/`). BND executes through the scheduler's eval hook
(`worker/src/scheduler/eval-hooks.ts`, landed by P0.5); until that module
exports `runBndCase`, BND reports pending — never a false green.
