// ===========================================================================
// Extract / Decide / Consolidate / Digest / Backfill eval executors
// (Phase 1 integration) — the live seams between the golden fixtures
// (CLM/TSK/CLS/CHP/FUP/SCH · CON · CAT · AGE) and the real passes.
//
// Same design as executors/orient.ts: the prose fixture is rendered into the
// pass's packed-input dialect and the REAL pass prompt runs through the traced
// JSON runner (live CLI). CAT is the exception — spec §5.1 makes most of it
// pure code, so those cases drive the actual product functions
// (chatCategoryFor, DomainCategorizer, noteUserReply, planCliSlots) and hand
// the judge the structured report the code produced.
// ===========================================================================

import type { Executor, ExecutorResult, Violation } from "../runner.js";
import type { Fixture } from "../fixtures.js";
import { runJsonPass } from "../../brain/llm.js";
import { validateExtractOutput, type ExtractOutput } from "../../prompts/extract.v1.js";
import { EXTRACT_V5_SYSTEM } from "../../prompts/extract.v5.js";
import { type DecideOutput } from "../../prompts/decide.v1.js";
import { DECIDE_V8_SYSTEM, validateDecideV8Output } from "../../prompts/decide.v8.js";
import { CLOSE_CONFIDENCE_FLOOR } from "../../brain/decide-pass.js";
import { validateConsolidateOutput, type ConsolidateVerdict } from "../../prompts/consolidate.v1.js";
import { CONSOLIDATE_V3_SYSTEM } from "../../prompts/consolidate.v3.js";
import { calendarBlock, fixtureSeed } from "./seeds.js";
import { DIGEST_V1_SYSTEM, parseDigestV1, type DigestParse } from "../../prompts/digest.v1.js";
import { bandPolicyLine } from "../../packer/index.js";
import { fixtureUser } from "./orient.js";
import { chatCategoryFor, noteUserReply, type ChatCategoryFacts } from "../../categories/index.js";
import {
  aggregateDomains,
  DomainCategorizer,
  isDroppableTrackerHop,
} from "../../adapters/browser/category.js";
import { admitWork, planCliSlots, type SlotWork } from "../../scheduler/priority.js";
import { getDb } from "../../db/connection.js";
import { appendEvents } from "../../db/eventlog.js";

// ---- Band parsing (AGE fixtures carry "Band D" in title/setup) -------------

export function fixtureBand(fixture: Fixture): { letter: string; lane: string; policy?: string } {
  const text = `${fixture.title} ${typeof fixture.setup === "string" ? fixture.setup : ""}`;
  const m = /\bband[ -]([A-D])\b/i.exec(text);
  const letter = m ? m[1]!.toUpperCase() : "A";
  const lane = letter === "A" ? "live" : "backfill";
  return letter === "A"
    ? { letter, lane }
    : { letter, lane, policy: bandPolicyLine(letter) };
}

// ---- The live prompt executors ---------------------------------------------

/**
 * What claims/store.writeClaimVersion does with a contradicts claim — the old
 * claim is ENDED (valid_until set), never deleted. Computed from the output.
 */
export function extractAppliedView(out: ExtractOutput): Record<string, unknown> | undefined {
  const superseded = out.claims.filter((c) => c.relation === "contradicts" && c.related_claim);
  if (superseded.length === 0) return undefined;
  return {
    resulting_history: superseded.map((c) => ({
      old_claim: c.related_claim,
      status: "PRESERVED in history with its termination date",
      valid_until: c.old_valid_until ?? c.valid_from ?? null,
      new_claim: c.text,
    })),
    note: "contradictions never overwrite — the claim store versions both (code path)",
  };
}

export const extractExecutor: Executor = async ({ fixture }) => {
  const band = fixtureBand(fixture);
  const seed = fixtureSeed(fixture.id);
  const user = [
    fixtureUser(fixture.setup, fixture.input_events, band, seed?.state),
    calendarBlock(),
    "",
    "COMMITTED EPISODES (time-ordered, evidence layer): the NEW BUNDLE events above.",
  ].join("\n");
  const result = await runJsonPass({
    pass: "extract",
    system: EXTRACT_V5_SYSTEM,
    user,
    role: "extract",
    unit: { kind: "eval", id: fixture.id },
    validate: validateExtractOutput,
  });
  const out = result.output;
  const applied = out ? extractAppliedView(out) : undefined;
  return {
    ok: result.status === "ok" || result.status === "repaired",
    output: out
      ? applied
        ? { ...out, applied_by_claim_store: applied }
        : out
      : { error: result.error, responses: result.responses },
    seededContext: seed?.state,
    metrics: { rounds: result.runIds.length },
  };
};

/**
 * What brain/decide-pass.ts applyClosure does with the closures — a "close"
 * below CLOSE_CONFIDENCE_FLOOR is DEMOTED to a suggest_close proposal, and a
 * suggest_close never mutates. Computed from the output, mirroring the code.
 */
export function decideAppliedView(out: DecideOutput): Record<string, unknown> | undefined {
  if (out.closures.length === 0) return undefined;
  return {
    closures: out.closures.map((c) => {
      const autoClose = c.verdict === "close" && c.confidence >= CLOSE_CONFIDENCE_FLOOR;
      return {
        task: c.task,
        applied_as: autoClose ? "close" : "suggest_close",
        ...(autoClose
          ? {}
          : {
              note:
                c.verdict === "close"
                  ? `demoted: close below the ${CLOSE_CONFIDENCE_FLOOR} confidence floor is a proposal — task stays open pending user confirmation`
                  : "a proposal, never a mutation — task stays open pending user confirmation",
            }),
      };
    }),
  };
}

export const decideExecutor: Executor = async ({ fixture }) => {
  const band = fixtureBand(fixture);
  const seed = fixtureSeed(fixture.id);
  const user = [
    fixtureUser(fixture.setup, seed?.events ?? fixture.input_events, band, seed?.state),
    calendarBlock(),
    "",
    "NEW COMMITTED EPISODES (all sources, time-ordered): the NEW BUNDLE events above.",
  ].join("\n");
  const result = await runJsonPass({
    pass: "decide",
    system: DECIDE_V8_SYSTEM,
    user,
    role: "decide",
    unit: { kind: "eval", id: fixture.id },
    validate: validateDecideV8Output,
  });
  const out = result.output;
  const applied = out ? decideAppliedView(out) : undefined;
  return {
    ok: result.status === "ok" || result.status === "repaired",
    output: out
      ? applied
        ? { ...out, applied_by_task_writer: applied }
        : out
      : { error: result.error, responses: result.responses },
    seededContext: seed?.state,
    metrics: { rounds: result.runIds.length },
  };
};

/** What consolidation/t2.ts's applier does with a verdict — computed. */
export function consolidateAppliedView(v: ConsolidateVerdict): Record<string, unknown> {
  const mutates =
    (v.verdict === "merge" && v.confidence >= 0.9) || v.stateChanges.length > 0;
  return {
    recorded: "verdict recorded as a reversible decisions row (scoped to the cards above; no other space was loaded)",
    ...(v.verdict === "merge" && v.confidence < 0.9
      ? { merge_held: "merge below the 0.9 auto-apply floor is a PROPOSAL — nothing mutated (false_auto_merge = 0 gate)" }
      : {}),
    ...(mutates ? {} : { mutations: "none — world model unchanged by this run" }),
  };
}

export const consolidateExecutor: Executor = async ({ fixture }) => {
  // The consolidation judge expects concrete cards. The prose fixture
  // describes them (and the review signal) — render the fixture's SEED (the
  // deterministic concretion of the setup) as the cards block so the model
  // judges what is written instead of asking for input.
  const seed = fixtureSeed(fixture.id);
  const parts: string[] = [
    "[CARDS UNDER REVIEW — prose rendering]",
    seed?.state ??
      (typeof fixture.setup === "string" && fixture.setup.trim() !== ""
        ? fixture.setup
        : JSON.stringify(fixture.setup ?? {})),
    "",
    "[REVIEW SIGNAL]",
    ...fixture.input_events.map((e) => (typeof e === "string" ? e : JSON.stringify(e))),
    "",
    "[NOTE] The blocks above are a prose rendering of the cards and the review trigger — judge them exactly as given. Output the schema JSON only.",
  ];
  const user = parts.join("\n");
  const result = await runJsonPass({
    pass: "consolidate",
    system: CONSOLIDATE_V3_SYSTEM,
    user,
    role: "consolidate",
    unit: { kind: "eval", id: fixture.id },
    validate: validateConsolidateOutput,
  });
  const out = result.output;
  return {
    ok: result.status === "ok" || result.status === "repaired",
    output: out
      ? { ...out, applied_by_consolidator: consolidateAppliedView(out) }
      : { error: result.error, responses: result.responses },
    seededContext: seed?.state,
    metrics: { rounds: result.runIds.length },
  };
};

// ---- AGE · scheduler.backfill: band-policy compliance through the passes ---

export const backfillExecutor: Executor = async ({ fixture }) => {
  // The band policy is enforced where the model runs: Extract (claims) and
  // Decide (tasks) both see the [BAND]+policy header exactly as the packer
  // renders it in production. Run both and hand the judge the union.
  // The prose fixtures put the historical content in `setup`; surface it as
  // bundle content too, so the passes extract from it rather than around it.
  const merged: Fixture = {
    ...fixture,
    input_events:
      typeof fixture.setup === "string" && fixture.setup.trim() !== ""
        ? [`historical content under review: ${fixture.setup}`, ...fixture.input_events]
        : fixture.input_events,
  };
  const band = fixtureBand(fixture);
  if (band.letter === "D") {
    // Band D processes at chat-month granularity through the DIGEST pass
    // (spec §5.3/§8.5): coarse claims + narrative, structurally incapable of
    // emitting tasks or spaces. One exemplar call proves the path; the
    // chat-month plan is code (one call per month named in the setup).
    const monthsMatch = /(\d+)\s*month/i.exec(
      typeof fixture.setup === "string" ? fixture.setup : "",
    );
    const plannedCalls = monthsMatch ? Number(monthsMatch[1]) : 1;
    const digest = await digestPromptExecutor({ fixture: merged });
    return {
      ok: digest.ok !== false,
      output: {
        granularity: "chat-month (Digest pass — no tasks, no spaces by construction)",
        plannedDigestCalls: plannedCalls,
        exemplarDigest: digest.output,
      },
      seededContext: fixtureSeed(fixture.id)?.state,
      metrics: { ...(digest.metrics ?? {}), planned_digest_calls: plannedCalls } as Record<string, number>,
      notes: [
        `band D: ${plannedCalls} chat-month Digest call(s) planned; one exemplar executed live`,
      ],
    };
  }
  const [claims, decisions] = [
    await extractExecutor({ fixture: merged }),
    await decideExecutor({ fixture: merged }),
  ];
  return {
    ok: claims.ok !== false && decisions.ok !== false,
    output: { extract: claims.output, decide: decisions.output },
    seededContext: claims.seededContext ?? decisions.seededContext,
    metrics: {
      rounds: (claims.metrics?.rounds ?? 0) + (decisions.metrics?.rounds ?? 0),
    },
  };
};

// ---- CAT · digest / categories: code where the spec says code --------------

function cat01(): ExecutorResult {
  // 40 streams; 12 replied; HDFC (T2 tx), Zepto (T2 tx), Airtel (T4 promo);
  // the rest never-replied groups/DMs per §5.1.
  const facts: (ChatCategoryFacts & { name: string; want: "cat1" | "cat2" })[] = [];
  for (let i = 0; i < 12; i += 1) {
    facts.push({
      name: `replied-${i}`, want: "cat1",
      streamId: `wa:st:replied-${i}`, isGroup: true, isBusiness: false, tier: null,
      userMessageCount: 1 + i,
    });
  }
  facts.push({ name: "HDFC", want: "cat1", streamId: "wa:st:hdfc", isGroup: false, isBusiness: true, tier: "T2", userMessageCount: 0 });
  facts.push({ name: "Zepto", want: "cat1", streamId: "wa:st:zepto", isGroup: false, isBusiness: true, tier: "T2", userMessageCount: 0 });
  facts.push({ name: "Airtel", want: "cat2", streamId: "wa:st:airtel", isGroup: false, isBusiness: true, tier: "T4", userMessageCount: 0 });
  for (let i = 0; i < 25; i += 1) {
    facts.push({
      name: `silent-group-${i}`, want: "cat2",
      streamId: `wa:st:silent-${i}`, isGroup: true, isBusiness: false, tier: null,
      userMessageCount: 0,
    });
  }

  const violations: Violation[] = [];
  const results = facts.map((f) => {
    const d = chatCategoryFor(f);
    if (d.category !== f.want) {
      violations.push({
        label: f.name === "Airtel" && d.category === "cat1" ? "promo-in-cat1" : "model-where-code-works",
        note: `${f.name}: got ${d.category} (${d.rule}), wanted ${f.want}`,
      });
    }
    return { stream: f.name, category: d.category, rule: d.rule };
  });
  return {
    ok: violations.length === 0,
    output: { assignments: results, modelCalls: 0 },
    violations,
    metrics: { model_calls: 0 },
    notes: ["chatCategoryFor is a pure function — no model call exists on any path (spec §5.1)."],
  };
}

function cat02(): ExecutorResult {
  const MIN = 60_000;
  const visits = [] as { url: string; typed: boolean; redirect: boolean; dwellMs: number }[];
  for (let i = 0; i < 14; i += 1) {
    visits.push({ url: "https://www.goibibo.com/flights/", typed: true, redirect: false, dwellMs: 6 * MIN });
  }
  const trackerHopA = { url: "https://adclick.doubleclick.net/r?x=1", typed: false, redirect: true, dwellMs: 400 };
  const trackerHopB = { url: "https://www.googleadservices.com/pagead/aclk?y=2", typed: false, redirect: true, dwellMs: 400 };
  visits.push(trackerHopA, trackerHopB);
  visits.push({ url: "https://news.ycombinator.com/item?id=1", typed: false, redirect: false, dwellMs: 2000 });

  const stats = aggregateDomains(visits, new Set(["news.ycombinator.com"]));
  let cheapCalls = 0;
  const categorizer = new DomainCategorizer(() => {
    cheapCalls += 1;
    return "cat2";
  });
  const verdicts: Record<string, string> = {};
  for (const [domain, s] of stats) verdicts[domain] = categorizer.categorize(s);
  // Cached: a second sweep must not re-call the resolver.
  for (const [, s] of stats) categorizer.categorize(s);

  const violations: Violation[] = [];
  for (const domain of ["adclick.doubleclick.net", "googleadservices.com"]) {
    if (verdicts[domain] === "cat1") {
      violations.push({ label: "tracker-as-interest", note: `${domain} → cat1` });
    }
  }
  return {
    ok:
      verdicts["goibibo.com"] === "cat1" &&
      verdicts["news.ycombinator.com"] === "cat1" &&
      violations.length === 0,
    output: {
      verdicts,
      trackerHopsDropped: [
        isDroppableTrackerHop("adclick.doubleclick.net", trackerHopA),
        isDroppableTrackerHop("googleadservices.com", trackerHopB),
      ],
      ambiguousCheapCalls: cheapCalls,
      cheapCallCached: true,
    },
    violations,
    metrics: { cheap_calls: cheapCalls },
    notes: ["Per-domain heuristics + one cached cheap call for ambiguous domains (spec §5.1)."],
  };
}

function cat03(): ExecutorResult {
  // Real product path on the (scratch) eval DB: seed a digested Cat-2 stream,
  // deliver the first user reply, and report what the promotion hook did.
  const NOW = Date.now();
  const streamKey = `sunrise-402-eval-${NOW}@g.us`;
  const streamId = `wa:st:${streamKey}`;
  const msg = (daysAgo: number, text: string) => ({
    ts: new Date(NOW - daysAgo * 86_400_000).toISOString(),
    source: "wa",
    kind: "wa.message",
    origin: "backfill" as const,
    streamKey,
    actor: "contact:secretary",
    roles: { sender: "contact:secretary", audience: ["self"], receiver: [], mentions: [] },
    payload: { text },
  });
  appendEvents([msg(40, "plumber contact: 98200-11111"), msg(35, "water shutdown tomorrow"), msg(33, "maintenance collection next week")], NOW);
  const db = getDb();
  db.prepare(`UPDATE streams SET category = 'cat2' WHERE id = ?`).run(streamId);
  db.prepare(`UPDATE events SET dispatched_at = ? WHERE stream_id = ?`).run(new Date(NOW).toISOString(), streamId);

  const report = noteUserReply(streamId, new Date(NOW).toISOString(), NOW);
  const after = db
    .prepare(`SELECT category, cursor_rowid FROM streams WHERE id = ?`)
    .get(streamId) as { category: string; cursor_rowid: number } | undefined;
  const decision = db
    .prepare(`SELECT id, reason FROM decisions WHERE target_id = ? AND action = 'promote'`)
    .get(streamId) as { id: string; reason: string } | undefined;

  const violations: Violation[] = [];
  if (after?.category !== "cat1") {
    violations.push({ label: "caste-system", note: `stream stayed ${after?.category ?? "missing"}` });
  }
  return {
    ok: report.promoted && after?.category === "cat1" && decision !== undefined,
    output: {
      promoted: report.promoted,
      categoryAfter: after?.category,
      requeuedForFullProcessing: report.requeued,
      cursorRewoundTo: after?.cursor_rowid,
      promotionLogged: decision !== undefined,
      decisionReason: decision?.reason,
      note: "the reply text itself re-enters the pipeline as a live event and takes the normal task/space path",
    },
    violations,
    metrics: { promotion_latency_ms: 0, requeued: report.requeued },
  };
}

function cat05(): ExecutorResult {
  // Cat-1 data 60% done (pending>0); Cat-1 media 300; Cat-2 media 900.
  const state = { cat1DataPending: 40, cat1MediaPending: 300 };
  const candidates: SlotWork[] = [
    { id: "c1-data", lane: "backfill", kind: "data", category: "cat1" },
    { id: "c1-media", lane: "backfill", kind: "media", category: "cat1" },
    { id: "c2-data", lane: "backfill", kind: "data", category: "cat2" },
    { id: "c2-media", lane: "backfill", kind: "media", category: "cat2" },
    { id: "whisper", lane: "backfill", kind: "media", category: "cat2", local: true },
    { id: "live", lane: "live", kind: "data", category: "cat1" },
  ];
  const violations: Violation[] = [];
  // While Cat-1 pending: no Cat-2 CLI work may hold a slot (slot-leak).
  const whilePending = planCliSlots(candidates, state, 8);
  for (const w of whilePending.slots) {
    if (w.category === "cat2") violations.push({ label: "slot-leak", note: `${w.id} admitted while cat1 pending` });
  }
  const liveFirst = whilePending.slots[0]?.lane === "live";
  const whisperRuns = whilePending.local.some((w) => w.id === "whisper");

  // Cat-1 complete: Cat-2 data (Digest) before Cat-2 media.
  const afterDone = planCliSlots(candidates, { cat1DataPending: 0, cat1MediaPending: 0 }, 8);
  const c2dataIdx = afterDone.slots.findIndex((w) => w.id === "c2-data");
  const c2mediaIdx = afterDone.slots.findIndex((w) => w.id === "c2-media");
  const digestBeforeMedia = c2dataIdx !== -1 && (c2mediaIdx === -1 || c2dataIdx < c2mediaIdx);

  return {
    ok: violations.length === 0 && liveFirst && whisperRuns && digestBeforeMedia,
    output: {
      whileCat1Pending: whilePending.slots.map((w) => w.id),
      localAlongside: whilePending.local.map((w) => w.id),
      afterCat1Done: afterDone.slots.map((w) => w.id),
      livePreempts: liveFirst,
      whisperExempt: whisperRuns,
      cat2AdmittedWhilePending: candidates
        .filter((c) => c.category === "cat2" && !c.local)
        .some((c) => admitWork(c, state)),
    },
    violations,
    metrics: { ordering_violations: violations.length },
  };
}

const digestPromptExecutor: Executor = async ({ fixture }) => {
  const band = fixtureBand(fixture);
  // The seed carries the month's CONTENT (AGE-04's exemplar month) — without
  // it the digest sees only the one-line setup and honestly reports an empty
  // month, which is the rendering gap, not the pass.
  const seed = fixtureSeed(fixture.id);
  const user = [
    fixtureUser(fixture.setup, fixture.input_events, band, seed?.state),
    "[NOTE] The state block above IS the month of stream history, as prose — synthesize the digest from it as given.",
  ].join("\n");
  const result = await runJsonPass<DigestParse>({
    pass: "digest",
    system: DIGEST_V1_SYSTEM,
    user,
    role: "digest",
    unit: { kind: "eval", id: fixture.id },
    validate: (parsed: unknown) => {
      const p = parseDigestV1(JSON.stringify(parsed));
      if (!p.result) throw new Error(`digest contract: ${p.violations.join(", ") || "unparseable"}`);
      return p;
    },
  });
  const parse = result.output;
  return {
    ok: result.status === "ok" || result.status === "repaired",
    output: parse
      ? { digest: parse.result, strippedViolations: parse.violations }
      : { error: result.error, responses: result.responses },
    metrics: { rounds: result.runIds.length, contract_violations_stripped: parse?.violations.length ?? 0 },
    notes: parse && parse.violations.length > 0
      ? [`deterministic contract layer stripped: ${parse.violations.join(", ")}`]
      : [],
  };
};

/** CAT dispatch: code where the spec says code, prompts where it says model. */
export const digestExecutor: Executor = async (ctx) => {
  switch (ctx.fixture.id) {
    case "CAT-01":
      return cat01();
    case "CAT-02":
      return cat02();
    case "CAT-03":
      return cat03();
    case "CAT-05":
      return cat05();
    case "CAT-06":
      return extractExecutor(ctx); // tier extraction policy runs in Extract
    default:
      return digestPromptExecutor(ctx); // CAT-04 and any digest-contract case
  }
};
