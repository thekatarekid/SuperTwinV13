// ===========================================================================
// [CODE] LLM-judge scorer — haiku over the local `claude` CLI (build P0.9).
//
// Both eval docs say the same thing: "an LLM judge grades Expected as
// satisfied/partial/missed against a rubric per case; Wrong modes are
// pattern-asserted by the judge and by code where possible". This module is
// that judge. It packs the case's setup, input events, expected rubric and
// wrong[] modes together with what the executor's REAL pass actually produced,
// and asks haiku for a strict JSON verdict.
//
// The judge is an injected function (`Judge`) so `npm test` never makes a live
// call — the harness self-test uses `stubJudge`, a deterministic grader that
// reads markers off the stub pass's output. The CLI wires `haikuJudge` in.
// ===========================================================================

import { claudeLocalProvider } from "../providers/claude-local/index.js";
import { withTraceContext } from "../traces/context.js";
import type { Provider } from "../providers/types.js";
import type { Fixture } from "./fixtures.js";
import type { ExecutorResult } from "./runner.js";

export type JudgeExpected = "satisfied" | "partial" | "missed";

export interface JudgeVerdict {
  expected: JudgeExpected;
  /** Labels of wrong[] modes the judge saw in the produced output. */
  wrongHits: string[];
  reasoning: string;
}

export type Judge = (fixture: Fixture, produced: ExecutorResult) => Promise<JudgeVerdict>;

/** Default judge model per the build plan ("LLM-judge scorer (haiku)"). */
export const JUDGE_MODEL = "haiku";

export function buildJudgePrompt(fixture: Fixture, produced: ExecutorResult): string {
  const wrongList = fixture.wrong
    .map((w) => `- "${w.label}": must be ABSENT — ${w.assert_absent}`)
    .join("\n");
  return [
    "You are a strict eval judge for a personal-memory system. Grade the SYSTEM OUTPUT",
    "against the EXPECTED rubric. Behavior matters, not exact strings.",
    "",
    `## Case ${fixture.id} · ${fixture.title}`,
    "## Setup (world state before)",
    JSON.stringify(fixture.setup, null, 2),
    "## Input events",
    JSON.stringify(fixture.input_events, null, 2),
    "## Expected (rubric)",
    JSON.stringify(fixture.expected, null, 2),
    "## Wrong modes (each is a named failure — report the label if you see it)",
    wrongList || "(none)",
    "## System output (what the pass under test produced)",
    JSON.stringify(produced.output, null, 2),
    "",
    "Answer with ONLY a JSON object, no fences, no prose around it:",
    '{"expected": "satisfied" | "partial" | "missed",',
    ' "wrong_hits": ["<label>", ...],',
    ' "reasoning": "<one or two sentences>"}',
    "",
    "Rules: 'satisfied' only when every element of the rubric is met.",
    "'partial' when some are. 'missed' when the output ignores the rubric.",
    "wrong_hits may only contain labels from the Wrong modes list.",
    "Unknown beats wrong: an honest 'unknown'/question is NOT a miss when the",
    "rubric calls for one.",
  ].join("\n");
}

/** Pulls the first JSON object out of a model reply (fence-tolerant). */
export function parseJudgeReply(text: string, allowedLabels: ReadonlySet<string>): JudgeVerdict {
  const stripped = text.replace(/```(?:json)?/g, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error(`judge reply has no JSON object: ${text.slice(0, 200)}`);
  const raw = JSON.parse(stripped.slice(start, end + 1)) as {
    expected?: unknown;
    wrong_hits?: unknown;
    reasoning?: unknown;
  };
  const expected = raw.expected;
  if (expected !== "satisfied" && expected !== "partial" && expected !== "missed") {
    throw new Error(`judge verdict 'expected' must be satisfied|partial|missed, got ${JSON.stringify(expected)}`);
  }
  const hits = Array.isArray(raw.wrong_hits) ? raw.wrong_hits : [];
  const wrongHits = hits
    .filter((h): h is string => typeof h === "string")
    .filter((h) => allowedLabels.has(h));
  return {
    expected,
    wrongHits,
    reasoning: typeof raw.reasoning === "string" ? raw.reasoning : "",
  };
}

export interface HaikuJudgeOptions {
  provider?: Provider;
  model?: string;
  timeoutMs?: number;
}

/**
 * The production judge: one bare haiku completion per case via the local
 * `claude` CLI (plainCompletion — no tools, one turn, no user settings).
 * Retries the call once on an unparseable reply.
 */
export function haikuJudge(options: HaikuJudgeOptions = {}): Judge {
  const provider = options.provider ?? claudeLocalProvider;
  const model = options.model ?? JUDGE_MODEL;
  const timeoutMs = options.timeoutMs ?? 120_000;

  async function callOnce(prompt: string, runId: string): Promise<string> {
    let text = "";
    // TRC-01: every model invocation runs inside a trace context — the judge
    // is a model call like any other.
    const result = await withTraceContext(
      { pass: "eval-judge", caller: "evals/judge", promptVersion: "judge.v1" },
      () =>
        provider.send({
          runId,
          message: prompt,
          model,
          plainCompletion: true,
          timeoutMs,
          onEvent: (e) => {
            if (e.type === "delta") text += e.text;
          },
        }),
    );
    if (result.status !== "ok") {
      throw new Error(`judge call failed: ${result.errorCode ?? "unknown"}`);
    }
    return text;
  }

  return async (fixture, produced) => {
    const prompt = buildJudgePrompt(fixture, produced);
    const labels = new Set(fixture.wrong.map((w) => w.label));
    const runId = `eval-judge-${fixture.id}-${Date.now()}`;
    const first = await callOnce(prompt, runId);
    try {
      return parseJudgeReply(first, labels);
    } catch {
      const second = await callOnce(prompt, `${runId}-retry`);
      return parseJudgeReply(second, labels);
    }
  };
}

/**
 * The self-test judge: no model. It grades off markers the stub pass plants in
 * its output — `verdict:<satisfied|partial|missed>` and `hits:<a,b>` — so the
 * harness's live-mode path is exercised end to end in `npm test` with zero
 * network and zero CLI spawns.
 */
export const stubJudge: Judge = (fixture, produced) => {
  const text = JSON.stringify(produced.output);
  const verdict = /verdict:(satisfied|partial|missed)/.exec(text)?.[1] as JudgeExpected | undefined;
  const labels = new Set(fixture.wrong.map((w) => w.label));
  const hitsRaw = /hits:([a-z0-9,-]+)/.exec(text)?.[1] ?? "";
  const wrongHits = hitsRaw.split(",").filter((h) => labels.has(h));
  return Promise.resolve({
    expected: verdict ?? "missed",
    wrongHits,
    reasoning: "stub judge (deterministic, marker-driven)",
  });
};
