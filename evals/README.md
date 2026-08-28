# evals/

The eval harness's fixture home. The V11 golden set (1,000 frozen fixtures
generated from the V11 doc) was deleted in P0.3 along with the frozen-replay
gating; the V13 golden set (SuperTwinV13_GoldenEvals_V2.md) lands with P1.3.

```
evals/
  selftest/   10 hand-written fixtures, one per assertion mode — they prove
              the harness itself (runner/report/gates in worker/src/evals/)
```

## Running

```sh
npm run eval -- --dir evals/selftest      # the harness self-test
npm run eval -- --dir <fixtures-dir>      # any fixture directory
```
