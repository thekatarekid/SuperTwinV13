// ===========================================================================
// Orient + Critic eval executors (build P1.3) — the live seam between the
// golden fixtures (TOP/ASN/CRE/CRI/ROL/…) and the real passes.
//
// The V13 fixtures are prose: `setup` describes the world, `input_events` the
// delta. The executor renders them into the pass's packed-input dialect —
// including the fixture's SEED (executors/seeds.ts), the deterministic
// concrete rendering of the setup line — and calls the REAL pass prompt
// through the traced JSON runner (which calls the real CLI in live eval runs
// — P0.9's design). The judge grades the output; `wrong[]` code assertions
// run on the parsed JSON.
//
// Outputs carry an `applied_by_commit_layer` annotation: what the production
// commit path (brain/commit.ts) does with the parsed output, computed BY CODE
// from the output itself — proposals born 'proposed' in the review queue,
// flags queueing a Tier-2 review. The judge grades the system, not the raw
// model text (the r1 gate report's option c).
// ===========================================================================

import type { Executor } from "../runner.js";
import { runJsonPass } from "../../brain/llm.js";
import { parseOrientOutput, type OrientOutput } from "../../brain/orient.js";
import { parseCriticOutput, type CriticOutput } from "../../brain/critic.js";
import { ORIENT_V6 } from "../../prompts/orient.v6.js";
import { CRITIC_V4 } from "../../prompts/critic.v4.js";
import { fixtureSeed } from "./seeds.js";

function prose(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v, null, 1);
}

/** Render a prose fixture into the packed-input dialect the pass expects. */
export function fixtureUser(
  setup: unknown,
  inputEvents: unknown[],
  band: { letter: string; lane: string; policy?: string } = { letter: "A", lane: "live" },
  seedState?: string,
): string {
  const lines: string[] = [`[BAND] ${band.letter} ${band.lane}   [MODE] propose-only`];
  if (band.policy) lines.push(band.policy);
  if (setup !== undefined && setup !== null && setup !== "") {
    // Labelled the way the packer labels it: this prose IS the retrieval
    // result — existing spaces named here are live attach candidates.
    lines.push(`[EXISTING STATE + CANDIDATE SPACES] ${prose(setup)}`);
  }
  if (seedState) {
    lines.push(`[STATE DETAIL — the setup above, rendered concrete]`);
    lines.push(seedState);
  }
  lines.push(`[NEW BUNDLE] ${inputEvents.length} events`);
  inputEvents.forEach((e, i) => lines.push(`  e${i + 1}: ${prose(e)}`));
  lines.push(
    "[NOTE] The blocks above are a prose rendering of the packed context — act on them exactly as given. Output the schema JSON only.",
  );
  return lines.join("\n");
}

/**
 * Render a CRITIC fixture: the setup + input events describe SEEDED writes
 * from another pass — number them, because the schema verdicts by item number.
 */
export function criticFixtureUser(
  setup: unknown,
  inputEvents: unknown[],
  seed?: { state?: string; items?: string[] },
): string {
  const lines: string[] = ["[BAND] A live   [MODE] propose-only"];
  if (setup !== undefined && setup !== null && setup !== "") {
    lines.push(`[CONTEXT] ${prose(setup)}`);
  }
  if (seed?.state) {
    lines.push("[CONTEXT DETAIL — the setup above, rendered concrete]");
    lines.push(seed.state);
  }
  const items =
    seed?.items && seed.items.length > 0
      ? seed.items
      : inputEvents.length > 0
        ? inputEvents.map((e) => prose(e))
        : [prose(setup)];
  lines.push(`[WRITES TO GRADE] ${items.length} item(s) — one verdict per numbered item`);
  items.forEach((e, i) => lines.push(`  ${i + 1}: ${e}`));
  lines.push(
    "[NOTE] The context and items above are a prose rendering of the seeded pass output and its retrieval — grade them exactly as given. Output the schema JSON only.",
  );
  return lines.join("\n");
}

/**
 * What brain/commit.ts does with an Orient output — computed, not modeled.
 * When the tick produced proposals, the REAL Critic verdicts (production runs
 * Critic over every tick's writes before commit) decide each proposal's fate
 * exactly the way commit.ts applies them: reject → never created ·
 * downgrade_to_unsorted → held in unsorted · commit/flag → review queue.
 */
export function orientAppliedView(
  out: OrientOutput,
  criticVerdicts?: CriticOutput | null,
): Record<string, unknown> {
  const proposalFate = (i: number): { status: string; note: string } => {
    const v = criticVerdicts?.verdicts.find((x) => x.item === i + 1);
    if (v?.verdict === "reject") {
      return { status: "rejected_by_critic", note: `no space created (critic: ${v.reason ?? "reject"})` };
    }
    if (v?.verdict === "downgrade_to_unsorted") {
      return {
        status: "held_in_unsorted",
        note: `NOT a space — the critic downgraded it to unsorted (${v.reason ?? "insufficient goal evidence"})`,
      };
    }
    return {
      status: "proposed",
      note: "review-queue entry created; NO active space exists until the user approves",
    };
  };
  return {
    mode: "propose-only (enforced by the commit layer)",
    ...(criticVerdicts ? { critic_gate: "the REAL Critic pass graded this tick's writes (production order)" } : {}),
    proposals: out.proposals.map((p, i) => ({
      label: p.label,
      ...proposalFate(i),
    })),
    attached_episodes: out.episodes.filter((e) => e.space).length,
    unsorted_held: out.unsorted.length,
    reversibility: "every write lands via the single writer with a decisions row (reversible)",
  };
}

/**
 * Run the REAL Critic over an Orient tick's proposals — the same gate every
 * production tick passes before commit (P1.3 map→grade→commit). Returns null
 * when there is nothing to grade or the call fails (the applied view then
 * annotates the un-gated commit behavior as before).
 */
export async function criticOverProposals(
  fixtureId: string,
  setup: unknown,
  out: OrientOutput,
): Promise<CriticOutput | null> {
  if (out.proposals.length === 0) return null;
  const items = out.proposals.map(
    (p) =>
      `SPACE PROPOSAL "${p.label}"${p.life_area ? ` (life_area ${p.life_area})` : ""}${
        p.goal ? ` — goal: ${p.goal}` : " — no goal stated"
      }; confidence ${p.confidence}; evidence events: ${p.episode_events.join(", ") || "(none)"}`,
  );
  try {
    const result = await runJsonPass({
      pass: CRITIC_V4.pass,
      system: CRITIC_V4.system,
      user: criticFixtureUser(setup, [], { items }),
      role: "critic",
      unit: { kind: "eval-critic", id: fixtureId },
      validate: parseCriticOutput,
    });
    return result.output ?? null;
  } catch {
    return null;
  }
}

/** What brain/commit.ts does with a Critic output — computed, not modeled. */
export function criticAppliedView(out: CriticOutput): Record<string, unknown> {
  const flags = out.verdicts.filter((v) => v.verdict === "flag_overlap");
  return {
    committed: out.verdicts.filter((v) => v.verdict === "commit").length,
    rejected: out.verdicts.filter((v) => v.verdict === "reject").length,
    flags: flags.map((f) => ({
      overlap_space: f.space_id ?? null,
      note: "write committed AND a Tier-2 review job was enqueued immediately (t2_review_queue)",
    })),
  };
}

export const orientExecutor: Executor = async ({ fixture }) => {
  const seed = fixtureSeed(fixture.id);
  const user = fixtureUser(fixture.setup, seed?.events ?? fixture.input_events, undefined, seed?.state);
  const result = await runJsonPass({
    pass: ORIENT_V6.pass,
    system: ORIENT_V6.system,
    user,
    role: "orient",
    unit: { kind: "eval", id: fixture.id },
    validate: parseOrientOutput,
  });
  const out = result.output;
  const verdicts = out ? await criticOverProposals(fixture.id, fixture.setup, out) : null;
  return {
    ok: result.status === "ok" || result.status === "repaired",
    output: out
      ? { ...out, applied_by_commit_layer: orientAppliedView(out, verdicts) }
      : { error: result.error, responses: result.responses },
    seededContext: [
      seed?.state,
      seed?.events
        ? `Concrete event rendering of the Input:\n${seed.events.map((e, i) => `  e${i + 1}: ${e}`).join("\n")}`
        : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
    metrics: { rounds: result.runIds.length },
  };
};

export const criticExecutor: Executor = async ({ fixture }) => {
  const seed = fixtureSeed(fixture.id);
  const result = await runJsonPass({
    pass: CRITIC_V4.pass,
    system: CRITIC_V4.system,
    user: criticFixtureUser(fixture.setup, fixture.input_events, seed),
    role: "critic",
    unit: { kind: "eval", id: fixture.id },
    validate: parseCriticOutput,
  });
  const out = result.output;
  return {
    ok: result.status === "ok" || result.status === "repaired",
    output: out
      ? { ...out, applied_by_commit_layer: criticAppliedView(out) }
      : { error: result.error, responses: result.responses },
    seededContext: [seed?.state, seed?.items ? `Writes graded:\n${seed.items.map((s, i) => `  ${i + 1}: ${s}`).join("\n")}` : undefined]
      .filter(Boolean)
      .join("\n"),
    metrics: { rounds: result.runIds.length },
  };
};
