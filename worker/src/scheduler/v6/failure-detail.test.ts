// ===========================================================================
// C6 · a crash inside the understanding pipeline says WHERE it crashed.
//
// Five history bundles dead-lettered in the field against the bare string
// "Maximum call stack size exceeded" — no file, no frame, nothing to act on,
// in the log or in `bundle_attempts`. The dispatcher recorded `err.message`
// and dropped the stack. Deterministic; reaches no model.
// ===========================================================================

import { describe, expect, it } from "vitest";

import { describeSinkFailure } from "./dispatch.js";

describe("C6 · describeSinkFailure", () => {
  it("carries the top frames beside the message, so the culprit is named", () => {
    const err = (() => {
      function inner(): Error {
        return new Error("Maximum call stack size exceeded");
      }
      function outer(): Error {
        return inner();
      }
      return outer();
    })();

    const detail = describeSinkFailure(err);
    expect(detail).toContain("Maximum call stack size exceeded");
    expect(detail).toContain("at ");
    expect(detail).toContain("failure-detail.test.ts");
  });

  it("clips, so a deep stack can never crowd out the message", () => {
    const err = new Error("boom");
    err.stack = `Error: boom\n${Array.from({ length: 400 }, (_, i) => `    at frame${i} (/very/long/path/to/module${i}.ts:${i}:1)`).join("\n")}`;
    const detail = describeSinkFailure(err);
    expect(detail.startsWith("boom — at frame0")).toBe(true);
    expect(detail.length).toBeLessThanOrEqual(900);
    // Four frames is the budget: enough to name the culprit, not a core dump.
    expect(detail.split(" | ")).toHaveLength(4);
  });

  it("a stackless error still reads as its message, not as 'undefined'", () => {
    const err = new Error("no stack here");
    err.stack = undefined;
    expect(describeSinkFailure(err)).toBe("no stack here");
  });

  it("a thrown non-Error is stringified rather than swallowed", () => {
    expect(describeSinkFailure("plain string")).toBe("plain string");
    expect(describeSinkFailure(42)).toBe("42");
  });
});
