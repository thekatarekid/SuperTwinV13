// ===========================================================================
// [CODE] Bar intent router (build P4.1, spec §14.8.1).
//
// One input, no modes: each submission is classified search / question /
// action / correction by one traced resolved-provider call through the prompt runner
// (TRC-01: traced, accounted, repair-bounded like every LLM step). The
// classifier is injectable so unit tests stay offline; ambiguity and every
// failure default to search — the cheapest, instantly revisable outcome.
// ===========================================================================

import {
  BAR_INTENT_INSTRUCTIONS,
  BAR_INTENT_VERSION,
  packIntentInput,
  parseIntentOutput,
  type BarIntent,
} from "../prompts/bar-intent.v1.js";
import { runJsonPass } from "../brain/llm.js";

export type { BarIntent };

/** Utterance → intent. Injectable so unit tests stay offline. */
export type IntentRouter = (text: string) => Promise<BarIntent>;

/**
 * The production router: one resolved-provider JSON call through the traced runner
 * (the bar-intent contract is `{"intent": "..."}` on one line). A dead
 * provider or an unusable answer routes to search rather than erroring the
 * bar — the spec's ambiguity rule, enforced in code.
 */
export const routeViaModel: IntentRouter = async (text) => {
  try {
    const result = await runJsonPass<BarIntent>({
      pass: BAR_INTENT_VERSION,
      system: BAR_INTENT_INSTRUCTIONS,
      user: packIntentInput(text),
      role: "classify",
      cohortId: null,
      unit: { kind: "bar-intent", id: "bar" },
      validate: (parsed) => {
        const intent = parseIntentOutput(JSON.stringify(parsed));
        return intent;
      },
    });
    return result.output ?? "search";
  } catch {
    return "search";
  }
};
