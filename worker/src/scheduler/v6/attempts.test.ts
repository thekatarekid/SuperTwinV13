// ===========================================================================
// Three strikes (attempts.ts; BND-11's schedule half). Deterministic.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { attemptEligibility, listDeadLetters, MAX_BUNDLE_ATTEMPTS, nextAttemptAtMs, recordFailedAttempt, recordSuccess, RETRY_DELAY_MS } from "./attempts.js";
import { MIN, openScratchDb, T0, type ScratchDb } from "./testutil.js";

let db: ScratchDb;
beforeEach(() => {
  db = openScratchDb("supertwin-attempts-");
});
afterEach(() => db.close());

const ref = { streamId: "wa:st:g@g.us", minRowid: 10, maxRowid: 14 };

describe("attempt schedule 0 · 5 · 10 minutes, then dead letter", () => {
  it("fresh → eligible; after a failure → not before +5 min; the third failure dead-letters", () => {
    expect(attemptEligibility(ref, T0)).toMatchObject({ eligible: true, deadLettered: false, attempts: 0 });

    const first = recordFailedAttempt(ref, "quarantined", T0);
    expect(first).toMatchObject({ deadLettered: false });
    expect(first.row.attempts).toBe(1);
    expect(nextAttemptAtMs(first.row)).toBe(T0 + RETRY_DELAY_MS);
    expect(attemptEligibility(ref, T0 + MIN)).toMatchObject({ eligible: false, deadLettered: false, nextAttemptAtMs: T0 + 5 * MIN });
    expect(attemptEligibility(ref, T0 + 5 * MIN).eligible).toBe(true);

    const second = recordFailedAttempt(ref, "quarantined", T0 + 5 * MIN);
    expect(second.deadLettered).toBe(false);
    expect(attemptEligibility(ref, T0 + 9 * MIN).eligible).toBe(false);
    expect(attemptEligibility(ref, T0 + 10 * MIN).eligible).toBe(true);

    const third = recordFailedAttempt(ref, "quarantined", T0 + 10 * MIN);
    expect(third.deadLettered).toBe(true);
    expect(third.row.attempts).toBe(MAX_BUNDLE_ATTEMPTS);
    expect(attemptEligibility(ref, T0 + 60 * MIN)).toMatchObject({ eligible: false, deadLettered: true });
    expect(listDeadLetters().map((r) => r.bundleKey)).toEqual(["wa:st:g@g.us:10-14"]);

    // A fourth failure never re-counts; the dead letter stands.
    const fourth = recordFailedAttempt(ref, "again", T0 + 90 * MIN);
    expect(fourth.row.attempts).toBe(3);
    expect(fourth.row.deadLetterAt).toBe(third.row.deadLetterAt);
  });

  it("a success clears the row", () => {
    recordFailedAttempt(ref, "boom", T0);
    recordSuccess(ref);
    expect(attemptEligibility(ref, T0)).toMatchObject({ eligible: true, attempts: 0, row: null });
  });
});
