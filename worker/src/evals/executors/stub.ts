// ===========================================================================
// [CODE] The self-test stub pass (`selftest.stub`) — build P0.9's "harness
// self-test with a stub pass".
//
// The stub is a deterministic pass: it reads a tiny script out of the
// fixture's first input event and produces accordingly, so every harness path
// (code verdicts, violations, metrics, gate observations, throwing executors,
// live-mode judging via `stubJudge`) is exercised in `npm test` with no model,
// no CLI spawn and no network.
//
// Script fields (all optional) on input_events[0]:
//   { "stub": { "ok": false, "violations": [{"label": "..."}],
//               "metrics": {"containment": 0.99}, "throw": "boom",
//               "output": {...}, "gate_observations": [...] } }
// Absent a script, the stub echoes the events back as its output.
// ===========================================================================

import type { GateInput } from "../gates.js";
import type { Executor, ExecutorResult, Violation } from "../runner.js";

interface StubScript {
  ok?: boolean;
  violations?: Violation[];
  metrics?: Record<string, number>;
  throw?: string;
  output?: unknown;
  gate_observations?: GateInput[];
}

function scriptOf(input: unknown): StubScript {
  if (typeof input === "object" && input !== null && "stub" in input) {
    return (input as { stub: StubScript }).stub ?? {};
  }
  return {};
}

export const stubExecutor: Executor = ({ fixture }) => {
  const script = scriptOf(fixture.input_events[0]);
  if (script.throw) throw new Error(script.throw);
  const result: ExecutorResult = {
    output: script.output ?? { echoed: fixture.input_events },
  };
  if (script.ok !== undefined) result.ok = script.ok;
  if (script.violations) result.violations = script.violations;
  if (script.metrics) result.metrics = script.metrics;
  if (script.gate_observations) result.gateObservations = script.gate_observations;
  return result;
};
