// ===========================================================================
// Orient + Critic eval executors (build P1.3) — the live seam between the
// golden fixtures (TOP/ASN/CRE/CRI/ROL/…) and the real passes.
//
// The V13 fixtures are prose: `setup` describes the world, `input_events` the
// delta. The executor renders them into the pass's packed-input dialect and
// calls the REAL pass prompt through the traced JSON runner (which calls the
// real CLI in live eval runs — P0.9's design). The judge grades the output;
// `wrong[]` code assertions run on the parsed JSON.
// ===========================================================================

import type { Executor } from "../runner.js";
import { runJsonPass } from "../../brain/llm.js";
import { parseOrientOutput } from "../../brain/orient.js";
import { parseCriticOutput } from "../../brain/critic.js";
import { ORIENT_V3 } from "../../prompts/orient.v3.js";
import { CRITIC_V1 } from "../../prompts/critic.v1.js";

function prose(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v, null, 1);
}

/** Render a prose fixture into the packed-input dialect the pass expects. */
export function fixtureUser(
  setup: unknown,
  inputEvents: unknown[],
  band: { letter: string; lane: string; policy?: string } = { letter: "A", lane: "live" },
): string {
  const lines: string[] = [`[BAND] ${band.letter} ${band.lane}   [MODE] propose-only`];
  if (band.policy) lines.push(band.policy);
  if (setup !== undefined && setup !== null && setup !== "") {
    lines.push(`[SETUP] ${prose(setup)}`);
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
export function criticFixtureUser(setup: unknown, inputEvents: unknown[]): string {
  const lines: string[] = ["[BAND] A live   [MODE] propose-only"];
  if (setup !== undefined && setup !== null && setup !== "") {
    lines.push(`[CONTEXT] ${prose(setup)}`);
  }
  lines.push(`[WRITES TO GRADE] ${Math.max(1, inputEvents.length)} item(s) — one verdict per numbered item`);
  if (inputEvents.length === 0) {
    lines.push(`  1: ${prose(setup)}`);
  } else {
    inputEvents.forEach((e, i) => lines.push(`  ${i + 1}: ${prose(e)}`));
  }
  lines.push(
    "[NOTE] The context and items above are a prose rendering of the seeded pass output and its retrieval — grade them exactly as given. Output the schema JSON only.",
  );
  return lines.join("\n");
}

export const orientExecutor: Executor = async ({ fixture }) => {
  const result = await runJsonPass({
    pass: ORIENT_V3.pass,
    system: ORIENT_V3.system,
    user: fixtureUser(fixture.setup, fixture.input_events),
    role: "orient",
    unit: { kind: "eval", id: fixture.id },
    validate: parseOrientOutput,
  });
  return {
    ok: result.status === "ok" || result.status === "repaired",
    output: result.output ?? { error: result.error, responses: result.responses },
    metrics: { rounds: result.runIds.length },
  };
};

export const criticExecutor: Executor = async ({ fixture }) => {
  const result = await runJsonPass({
    pass: CRITIC_V1.pass,
    system: CRITIC_V1.system,
    user: criticFixtureUser(fixture.setup, fixture.input_events),
    role: "critic",
    unit: { kind: "eval", id: fixture.id },
    validate: parseCriticOutput,
  });
  return {
    ok: result.status === "ok" || result.status === "repaired",
    output: result.output ?? { error: result.error, responses: result.responses },
    metrics: { rounds: result.runIds.length },
  };
};
