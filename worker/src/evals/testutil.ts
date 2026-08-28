// [CODE] Test-only helper: a schema-valid fixture to override per test.
// Imported by the eval harness's own test files, never by production code.

import type { Fixture } from "./fixtures.js";

export function goodFixture(overrides: Partial<Fixture> = {}): Fixture {
  return {
    id: "ROL-01",
    category: "ROL",
    title: "@mention receiver + no task theft",
    pass: "orient+extract",
    mode: "live",
    setup: "roster: self=Aditya, rohan, tanvi, k1; goa-gang group",
    input_events: [{ n: 1, ts: "2026-08-26T10:02+05:30", sender: "rohan", text: "@Karan book today" }],
    expected: "e1 receiver = [k1] via structural @mention; no task for self",
    wrong: [{ label: "task-theft", assert_absent: "a 'book ticket' task owned by self" }],
    gates: ["false_receiver_assignment", "party_accuracy"],
    source: { doc: "V2", section: "ROL-01 · @mention receiver + no task theft" },
    ...overrides,
  };
}
