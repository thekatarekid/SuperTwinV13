// ===========================================================================
// [CODE] Bar intent router (build P4.1, spec §14.8.1).
//
// One input, no modes: each submission is classified search / question /
// action / correction by one traced Haiku call through the prompt runner
// (TRC-01: traced, accounted, repair-bounded like every LLM step). The
// classifier is injectable so unit tests stay offline; ambiguity and every
// failure default to search — the cheapest, instantly revisable outcome.
// ===========================================================================

import { getSelectedModel } from "../db/settings.js";
import {
  BAR_INTENT_INSTRUCTIONS,
  BAR_INTENT_VERSION,
  packIntentInput,
  parseIntentOutput,
  type BarIntent,
} from "../prompts/bar-intent.v1.js";
import { runPrompt } from "../prompts/runner.js";

export type { BarIntent };

/** Utterance → intent. Injectable so unit tests stay offline. */
export type IntentRouter = (text: string) => Promise<BarIntent>;

/**
 * The production router: one Haiku call through the prompt runner — traced,
 * accounted, repair-bounded. A dead provider or an unusable answer routes to
 * search rather than erroring the bar.
 */
export const routeViaModel: IntentRouter = async (text) => {
  try {
    const result = await runPrompt({
      callType: BAR_INTENT_VERSION,
      legend: BAR_INTENT_INSTRUCTIONS,
      instructions: "",
      user: packIntentInput(text),
      role: "classify",
      cohortId: null,
      model: getSelectedModel("classify"),
      unit: { kind: "bar-intent", id: "bar" },
    });
    return parseIntentOutput(result.responses.join("\n"));
  } catch {
    return "search";
  }
};
