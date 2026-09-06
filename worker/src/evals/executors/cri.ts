// ===========================================================================
// [CODE] CRI — the critic executor (GoldenEvals V6 P1 §5.9; V6 P1 S3.5).
//
// The four V6 P1 cases are STRUCTURED fixtures: `setup.spaces` are the spaces
// in view, `setup.writes[]` the numbered write set to grade, `input_events`
// the bundle the pack shows (inside <untrusted>). The executor renders the
// same `[PACK]` + `[WRITES]` user block production's critic.v5 sees, runs
// the MECHANICAL layer (brain/critic.ts — coverage, verbatim quotes, stream
// tags, bridge-edge confidence; zero model calls), and then, for a live case,
// the REAL critic.v5 prompt through the traced JSON runner. Code merges the
// two exactly as production does (a code reject wins) and asserts the
// fixture's `expected.verdicts` and `expected.uncovered` BY CODE — the judge
// grades the same output on top. A `mode: "code"` case (CRI-04, the bridge
// edge at 0.6) never reaches a model: the mechanical layer alone must reject.
//
// The V1-era prose CRI fixtures (one-line setup, seeded items) still route to
// the legacy executor in executors/orient.ts, so a directory that mixes the
// two shapes keeps working.
// ===========================================================================

import { runJsonPass } from "../../brain/llm.js";
import {
  mechanicalCriticCheck,
  mergeCriticVerdicts,
  parseCriticOutput,
  renderEdgeItems,
  renderMechanicalBlock,
  verdictFor,
  type CriticEdgeItem,
  type CriticOutput,
  type CriticVerdictKind,
  type MechanicalReport,
} from "../../brain/critic.js";
import type { OrientOutput } from "../../brain/orient.js";
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from "../../packer/index.js";
import { CRITIC_VERSIONS } from "../../prompts/versions.js";
import type { Fixture } from "../fixtures.js";
import type { Executor, ExecutorResult, Violation } from "../runner.js";
import { criticExecutor as legacyCriticExecutor } from "./orient.js";

/** The prompt these fixtures accept: critic.v5 (Prompts_V6_Phase1 P-03). */
export const CRI_PROMPT = CRITIC_VERSIONS.v5;

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(v: unknown, dflt = ""): string {
  return typeof v === "string" ? v : dflt;
}
function num(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}
function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// ---- Fixture shape ---------------------------------------------------------

export interface CriEvent {
  id: string;
  ts: string;
  source: string;
  stream: string;
  actor: string;
  text: string;
  /** browser/screen lines carry `[app · title · doc]` after the source. */
  head?: string;
}

export interface CriSpace {
  id: string;
  label: string;
  goal?: string;
  exemplars: string[];
}

export type CriWriteKind = "episode" | "proposal" | "unsorted" | "edge" | "prepared" | "closure";

export interface CriWrite {
  kind: CriWriteKind;
  /** episode: join|new */
  action?: "join" | "new";
  episode?: string;
  stream?: string;
  events: string[];
  summary?: string;
  label?: string;
  space?: string;
  quote?: string;
  confidence: number;
  /** edge */
  edge_kind?: string;
  src?: string;
  dst?: string;
  /** prepared */
  prepared_kind?: string;
  grounded_in?: string[];
  /** closure */
  task?: string;
  verdict?: string;
}

export interface CriCase {
  now: string;
  lane: "live" | "history";
  spaces: CriSpace[];
  events: CriEvent[];
  writes: CriWrite[];
}

export function isStructuredCriFixture(fixture: Fixture): boolean {
  return Array.isArray(rec(fixture.setup).writes);
}

export function parseCriCase(fixture: Fixture): CriCase {
  const s = rec(fixture.setup);
  const spaces: CriSpace[] = (Array.isArray(s.spaces) ? s.spaces : []).map((raw) => {
    const o = rec(raw);
    return { id: str(o.id), label: str(o.label), ...(str(o.goal) ? { goal: str(o.goal) } : {}), exemplars: strs(o.exemplars) };
  });
  const events: CriEvent[] = fixture.input_events.map((raw, i) => {
    const o = rec(raw);
    return {
      id: str(o.id, `e${i + 1}`).toLowerCase(),
      ts: str(o.ts, "2026-09-05T10:00:00+05:30"),
      source: str(o.source, "wa"),
      stream: str(o.stream, "wa:goa-gang@g.us"),
      actor: str(o.actor, "contact:rohan"),
      text: str(o.text),
      ...(str(o.head) ? { head: str(o.head) } : {}),
    };
  });
  const writes: CriWrite[] = (Array.isArray(s.writes) ? s.writes : []).map((raw) => {
    const o = rec(raw);
    const kind = str(o.kind, "episode") as CriWriteKind;
    return {
      kind,
      ...(o.action === "join" || o.action === "new" ? { action: o.action } : {}),
      ...(str(o.episode) ? { episode: str(o.episode) } : {}),
      ...(str(o.stream) ? { stream: str(o.stream) } : {}),
      events: strs(o.events).map((e) => e.toLowerCase()),
      ...(str(o.summary) ? { summary: str(o.summary) } : {}),
      ...(str(o.label) ? { label: str(o.label) } : {}),
      ...(str(o.space) ? { space: str(o.space) } : {}),
      ...(str(o.quote) ? { quote: str(o.quote) } : {}),
      confidence: num(o.confidence, 0.9),
      ...(str(o.edge_kind) ? { edge_kind: str(o.edge_kind) } : {}),
      ...(str(o.src) ? { src: str(o.src) } : {}),
      ...(str(o.dst) ? { dst: str(o.dst) } : {}),
      ...(str(o.prepared_kind) ? { prepared_kind: str(o.prepared_kind) } : {}),
      ...(Array.isArray(o.grounded_in) ? { grounded_in: strs(o.grounded_in) } : {}),
      ...(str(o.task) ? { task: str(o.task) } : {}),
      ...(str(o.verdict) ? { verdict: str(o.verdict) } : {}),
    };
  });
  return {
    now: str(s.now, "2026-09-05T10:00:00+05:30"),
    lane: s.lane === "history" ? "history" : "live",
    spaces,
    events,
    writes,
  };
}

// ---- Rendering: the pack and the write set ---------------------------------

const ROSTER =
  "[ROSTER] 5 resolved\n" +
  "  self = Aditya (the user) · contact:rohan = Rohan (close friend, Goa gang) · contact:tanvi = Tanvi (close friend) · " +
  "contact:karan = Karan (friend) · contact:ma = Ma (Aditya's mother)";

function hhmm(ts: string): string {
  const m = /T(\d{2}:\d{2})/.exec(ts);
  return m ? m[1]! : "??:??";
}

/** Section tags in first-appearance order: S1 is the first event's stream. */
export function streamTags(events: readonly CriEvent[]): Map<string, string> {
  const tags = new Map<string, string>();
  for (const e of events) if (!tags.has(e.stream)) tags.set(e.stream, `S${tags.size + 1}`);
  return tags;
}

/** The V6 pack for a case: blocks, then the bundle inside ONE untrusted block. */
export function renderCriPack(c: CriCase): string {
  const tags = streamTags(c.events);
  const lines: string[] = [];
  lines.push(`[NOW] ${c.now} · lane ${c.lane} · band A · mode propose-only`);
  lines.push(ROSTER);
  lines.push("[OPEN TASKS] (none in these spaces)");
  lines.push("[CALENDAR] (nothing dated in the next 7 days)");
  if (c.spaces.length === 0) lines.push("[CANDIDATE SPACES] (none from retrieval)");
  else {
    lines.push(`[CANDIDATE SPACES] ${c.spaces.length} from retrieval (top 5; the full list is never shown)`);
    c.spaces.forEach((sp, i) => {
      lines.push(
        `  ${i + 1}. ${sp.id} "${sp.label}"${sp.goal ? ` · goal: ${sp.goal}` : ""}` +
          (sp.exemplars.length > 0 ? `\n     exemplars: ${sp.exemplars.map((x) => `"${x}"`).join(" · ")}` : ""),
      );
    });
  }
  lines.push("[BRIDGED] (none)");
  lines.push("[EPISODES] (none open or recent)");
  lines.push(`[BUNDLE] ${c.events.length} events · ${tags.size} stream${tags.size === 1 ? "" : "s"}`);
  lines.push(UNTRUSTED_OPEN);
  for (const [stream, tag] of tags) {
    lines.push(`[STREAM ${tag}: ${stream}]`);
    for (const e of c.events.filter((x) => x.stream === stream)) {
      const head = e.head ? ` [${e.head}]` : "";
      lines.push(` ${e.id} ${hhmm(e.ts)} ${e.source}${head} ${e.actor}: ${e.text.replace(/<(\/?)untrusted/gi, "<$1​untrusted")}`);
    }
  }
  lines.push(UNTRUSTED_CLOSE);
  return lines.join("\n");
}

/** One numbered `[WRITES]` line per write (Prompts_V6_Phase1 P-03 user block). */
export function renderWriteLine(w: CriWrite, n: number): string {
  const q = w.quote ? ` quote:"${w.quote}"` : "";
  switch (w.kind) {
    case "episode":
      return `${n} EPISODE ${w.action ?? "new"}${w.episode ? ` ${w.episode}` : ""} ${w.stream ?? "S1"} ${w.events.join(",")} "${w.summary ?? ""}"${
        w.space ? ` → ${w.space}` : ""
      }${q} conf ${w.confidence}`;
    case "proposal":
      // "new space" spelled out: without it the model read a proposal beside a
      // matching candidate as an attach to that space and committed (S3 gate).
      return `${n} PROPOSAL new space "${w.label ?? ""}" ${w.stream ?? "S1"} ${w.events.join(",")}${w.summary ? ` "${w.summary}"` : ""}${q} conf ${w.confidence}`;
    case "unsorted":
      return `${n} UNSORTED ${w.stream ?? "S1"} ${w.events.join(",")} "${w.summary ?? ""}" conf ${w.confidence}`;
    case "edge":
      return `${n} EDGE ${w.edge_kind ?? "bridge:url"} ${w.src ?? w.events[0] ?? "?"}→${w.dst ?? w.events[1] ?? "?"} conf ${w.confidence}`;
    case "prepared":
      return `${n} PREPARED ${w.prepared_kind ?? "needs_you"}${w.summary ? ` "${w.summary}"` : ""} grounded_in ${(w.grounded_in ?? w.events).join(",")}`;
    case "closure":
      return `${n} CLOSURE ${w.task ?? "?"} ${w.verdict ?? "done"}${q}${w.summary ? ` — ${w.summary}` : ""}`;
  }
}

/**
 * The write set as the Orient output + edge items the mechanical layer
 * grades. Item numbering is the fixture's: writes are numbered in order, so
 * episodes/proposals/edges are kept in that order (unsorted, prepared and
 * closures are not numbered by the mechanical layer — they are graded by the
 * model alone).
 */
export function writesAsOrientOutput(writes: readonly CriWrite[]): { output: OrientOutput; edges: CriticEdgeItem[]; itemOf: Map<number, number> } {
  const output: OrientOutput = { episodes: [], proposals: [], unsorted: [], questions: [] };
  const edges: CriticEdgeItem[] = [];
  // mechanical item number -> fixture item number (they coincide when the
  // fixture lists episodes, then proposals, then edges — the shape every
  // §5.9 case has; the map keeps the general case honest).
  const itemOf = new Map<number, number>();
  const order: Array<{ kind: "episode" | "proposal" | "edge"; n: number }> = [];
  writes.forEach((w, i) => {
    const n = i + 1;
    const evidence = w.quote ? [{ event_ids: w.events, quote: w.quote }] : [];
    if (w.kind === "episode") {
      output.episodes.push({
        action: w.action ?? "new",
        ...(w.episode ? { episode: w.episode } : {}),
        ...(w.stream ? { stream: w.stream } : {}),
        events: w.events,
        summary: w.summary ?? "",
        ...(w.space ? { space: w.space } : {}),
        evidence,
        confidence: w.confidence,
      });
      order.push({ kind: "episode", n });
    } else if (w.kind === "proposal") {
      output.proposals.push({
        label: w.label ?? "",
        ...(w.stream ? { stream: w.stream } : {}),
        episode_events: w.events,
        summary: w.summary ?? w.label ?? "",
        evidence,
        confidence: w.confidence,
      });
      order.push({ kind: "proposal", n });
    } else if (w.kind === "unsorted") {
      output.unsorted.push({ ...(w.stream ? { stream: w.stream } : {}), events: w.events, summary: w.summary ?? "", confidence: w.confidence });
    } else if (w.kind === "edge") {
      edges.push({ kind: w.edge_kind ?? "bridge:url", src: w.src ?? w.events[0] ?? "?", dst: w.dst ?? w.events[1] ?? "?", confidence: w.confidence });
      order.push({ kind: "edge", n });
    }
  });
  const ranked = [...order.filter((o) => o.kind === "episode"), ...order.filter((o) => o.kind === "proposal"), ...order.filter((o) => o.kind === "edge")];
  ranked.forEach((o, i) => itemOf.set(i + 1, o.n));
  return { output, edges, itemOf };
}

/** Re-number a mechanical report's item numbers back to the fixture's. */
function renumber(m: MechanicalReport, itemOf: Map<number, number>): MechanicalReport {
  const f = (n: number): number => itemOf.get(n) ?? n;
  return {
    ...m,
    notVerbatim: m.notVerbatim.map(f),
    multiStream: m.multiStream.map(f),
    edgeVerdicts: m.edgeVerdicts.map((v) => ({ ...v, item: f(v.item) })),
  };
}

export function renderCriUser(c: CriCase, mechanical: MechanicalReport): string {
  const lines = ["[PACK]", renderCriPack(c), "", "[WRITES]"];
  c.writes.forEach((w, i) => lines.push(renderWriteLine(w, i + 1)));
  const edgeItems = c.writes
    .map((w, i) => ({ w, n: i + 1 }))
    .filter(({ w }) => w.kind === "edge");
  if (edgeItems.length > 0) {
    // The [EDGES] block restates the edge items under their fixture numbers.
    const first = edgeItems[0]!.n;
    const contiguous = edgeItems.every(({ n }, i) => n === first + i);
    if (contiguous) {
      lines.push(
        ...renderEdgeItems(
          edgeItems.map(({ w }) => ({ kind: w.edge_kind ?? "bridge:url", src: w.src ?? w.events[0] ?? "?", dst: w.dst ?? w.events[1] ?? "?", confidence: w.confidence })),
          first,
        ),
      );
    }
  }
  lines.push(renderMechanicalBlock(mechanical));
  return lines.join("\n");
}

// ---- Assertions --------------------------------------------------------------

export interface ExpectedVerdict {
  item: number;
  verdict: CriticVerdictKind;
  space_id?: string;
}

export function expectedVerdicts(fixture: Fixture): { verdicts: ExpectedVerdict[]; uncovered: string[] | null } {
  const e = rec(fixture.expected);
  const verdicts = (Array.isArray(e.verdicts) ? e.verdicts : []).map((raw) => {
    const o = rec(raw);
    return {
      item: num(o.item, 1),
      verdict: str(o.verdict, "commit") as CriticVerdictKind,
      ...(str(o.space_id) ? { space_id: str(o.space_id) } : {}),
    };
  });
  return { verdicts, uncovered: Array.isArray(e.uncovered) ? strs(e.uncovered).map((x) => x.toLowerCase()) : null };
}

/** The wrong[] label a verdict mismatch maps to (only pushed when the fixture declares it). */
function mismatchLabel(expected: CriticVerdictKind, actual: CriticVerdictKind, kind: CriWriteKind | undefined): string {
  if (kind === "edge" && expected === "reject") return "edge-accepted";
  if (actual === "commit") return expected === "flag_overlap" ? "silent-commit" : "rubber-stamp";
  if (actual === "flag_overlap") return "flag-not-reject";
  if (actual === "reject") return expected === "downgrade_to_unsorted" ? "reject-not-downgrade" : "reject-on-doubt";
  return "downgrade-not-reject";
}

export interface CriAssessment {
  ok: boolean;
  violations: Violation[];
  notes: string[];
  matched: number;
}

export function assessCri(fixture: Fixture, merged: CriticOutput, mechanical: MechanicalReport): CriAssessment {
  const labels = new Set(fixture.wrong.map((w) => w.label));
  const { verdicts, uncovered } = expectedVerdicts(fixture);
  const kinds = (Array.isArray(rec(fixture.setup).writes) ? (rec(fixture.setup).writes as unknown[]) : []).map((w) => str(rec(w).kind, "episode") as CriWriteKind);
  const violations: Violation[] = [];
  const notes: string[] = [];
  let ok = true;
  let matched = 0;
  for (const exp of verdicts) {
    const got = verdictFor(merged, exp.item);
    if (got.verdict !== exp.verdict) {
      ok = false;
      const label = mismatchLabel(exp.verdict, got.verdict, kinds[exp.item - 1]);
      const note = `item ${exp.item}: expected ${exp.verdict}, got ${got.verdict}${got.reason ? ` (${got.reason})` : ""}`;
      if (labels.has(label)) violations.push({ label, note });
      else notes.push(note);
      continue;
    }
    if (exp.space_id) {
      const names = (got.space_id ?? "") === exp.space_id || (got.reason ?? "").includes(exp.space_id);
      if (!names) {
        ok = false;
        notes.push(`item ${exp.item}: ${exp.verdict} does not name ${exp.space_id} (space_id ${got.space_id ?? "—"}, reason ${JSON.stringify(got.reason ?? "")})`);
        continue;
      }
    }
    matched += 1;
  }
  if (uncovered) {
    const got = [...mechanical.uncovered].sort();
    const want = [...uncovered].sort();
    if (got.join(",") !== want.join(",")) {
      ok = false;
      const note = `coverage: expected uncovered [${want.join(", ")}], mechanical found [${got.join(", ")}]`;
      if (labels.has("coverage-miss")) violations.push({ label: "coverage-miss", note });
      else notes.push(note);
    }
  }
  return { ok, violations, notes, matched };
}

// ---- The executor --------------------------------------------------------------

export interface CriRun {
  user: string;
  mechanical: MechanicalReport;
  model?: CriticOutput;
  merged: CriticOutput;
  modelCalls: number;
  rounds: number;
  error?: unknown;
  responses?: string[];
}

/** Seedless: the pack is rendered from the fixture, nothing touches the DB. */
export async function runCriCase(fixture: Fixture): Promise<CriRun> {
  const c = parseCriCase(fixture);
  const { output, edges, itemOf } = writesAsOrientOutput(c.writes);
  const aliases = new Map(c.events.map((e) => [e.id, `${fixture.id}:${e.id}`]));
  const tags = streamTags(c.events);
  const eventTexts = new Map(c.events.map((e) => [e.id, e.text]));
  const eventStreams = new Map(c.events.map((e) => [e.id, tags.get(e.stream) ?? "S1"]));
  const mechanical = renumber(mechanicalCriticCheck({ output, aliases, eventTexts, eventStreams, edges }), itemOf);
  const user = renderCriUser(c, mechanical);
  if (fixture.mode === "code") {
    // Code alone: silence commits, the mechanical rejects stand.
    return { user, mechanical, merged: mergeCriticVerdicts({ verdicts: [] }, mechanical), modelCalls: 0, rounds: 0 };
  }
  const result = await runJsonPass({
    pass: CRI_PROMPT.pass,
    system: CRI_PROMPT.system,
    user,
    role: "critic",
    unit: { kind: "eval", id: fixture.id },
    validate: parseCriticOutput,
  });
  const model = result.output;
  return {
    user,
    mechanical,
    ...(model ? { model } : {}),
    merged: model ? mergeCriticVerdicts(model, mechanical) : mergeCriticVerdicts({ verdicts: [] }, mechanical),
    modelCalls: result.runIds.length,
    rounds: result.runIds.length,
    ...(model ? {} : { error: result.error, responses: result.responses }),
  };
}

export const criV6Executor: Executor = async ({ fixture }): Promise<ExecutorResult> => {
  const run = await runCriCase(fixture);
  if (fixture.mode === "live" && !run.model) {
    return {
      ok: false,
      output: { error: run.error, responses: run.responses, mechanical: run.mechanical },
      notes: ["critic.v5 produced no parseable output"],
      metrics: { model_calls: run.modelCalls, rounds: run.rounds },
    };
  }
  const assessment = assessCri(fixture, run.merged, run.mechanical);
  const expected = expectedVerdicts(fixture).verdicts.length;
  return {
    ok: assessment.ok,
    output: {
      verdicts: run.merged.verdicts,
      uncovered: run.merged.uncovered ?? [],
      ...(run.model?.uncovered ? { model_uncovered: run.model.uncovered } : {}),
      mechanical: run.mechanical,
      applied_by_commit_layer: {
        committed: run.merged.verdicts.filter((v) => v.verdict === "commit").length,
        rejected: run.merged.verdicts.filter((v) => v.verdict === "reject").length,
        downgraded: run.merged.verdicts.filter((v) => v.verdict === "downgrade_to_unsorted").length,
        flags: run.merged.verdicts.filter((v) => v.verdict === "flag_overlap").map((v) => v.space_id ?? null),
        note: "reject → never written · downgrade → unsorted · flag_overlap → commits AND queues a Tier-2 review · uncovered aliases are flagged on the bundle",
      },
    },
    seededContext: run.user,
    violations: assessment.violations,
    notes: assessment.notes,
    metrics: {
      model_calls: run.modelCalls,
      rounds: run.rounds,
      verdict_accuracy: expected > 0 ? assessment.matched / expected : 1,
      uncovered: run.mechanical.uncovered.length,
    },
    gateObservations: [
      { gateId: "critic_verdict_accuracy", passed: assessment.ok, counted: true },
      { gateId: "critic_coverage", passed: assessment.ok, counted: true },
    ],
  };
};

/** Registered under pass "critic": structured V6 P1 fixtures here, prose V1 fixtures to the legacy path. */
export const criExecutor: Executor = async (ctx) =>
  isStructuredCriFixture(ctx.fixture) ? criV6Executor(ctx) : legacyCriticExecutor(ctx);
