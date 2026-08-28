// ===========================================================================
// Browser tools — build P3.4, spec §12.4: the harness registered into the
// executor tool registry (P3.3's ToolRegistry / invokeTool choke point).
//
// SAFETY IS THE TABLE ITSELF (same doctrine as assist executor-lite / AST-04
// and the executor's EXE-04): this is the COMPLETE browser capability surface
// an executor session gets. There is NO credential tool, NO password tool, NO
// cookie-export tool, NO send/pay/book tool — they do not exist, so no prompt
// injection can reach one (BRW-08). Every tool is risk "safe": read-only
// capture at human pacing. The type tool's handler refuses credential fields
// in code besides; the risky (payment/send) class of executor tool lives
// elsewhere and is gated by approval tokens at invokeTool.
//
// Handlers take a JSON string and return a JSON string, matching P3.3's
// ExecutorTool contract, and go through the harness — where the
// SafetyController (kill-switch + hard-stop) and Pacer gates cannot be
// skipped.
// ===========================================================================

import { ToolRegistry, type ExecutorTool } from "../executor/tools.js";
import type { BrowserHarness } from "./harness.js";

function parse(input: string): Record<string, unknown> {
  if (!input.trim()) return {};
  try {
    const v = JSON.parse(input);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    throw new Error(`browser tool input must be JSON object: ${input.slice(0, 80)}`);
  }
}

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`missing required string input "${key}"`);
  }
  return v;
}

/**
 * Register the browser tool surface onto an executor registry. Returns the
 * registered tool names. Every one is risk "safe" — the name guard in the
 * registry would REFUSE any that read as risky, which is the point.
 */
export function registerBrowserTools(
  registry: ToolRegistry,
  harness: BrowserHarness,
): string[] {
  const defs: ExecutorTool[] = [
    {
      name: "browser_open_tab",
      description:
        "Open a new agent browser tab (isolated from the user's tabs). " +
        'Input {"purpose": string}. Returns {"targetId"} for other tools.',
      risk: "safe",
      handler: async (input) =>
        JSON.stringify({
          targetId: await harness.createAgentTab(str(parse(input), "purpose")),
        }),
    },
    {
      name: "browser_navigate",
      description:
        "Navigate an agent tab to a URL (human-paced; hard-stops on any " +
        'challenge or login wall). Input {"targetId","url"}. Returns the page sample.',
      risk: "safe",
      handler: async (input) => {
        const p = parse(input);
        return JSON.stringify(
          await harness.navigate(str(p, "targetId"), str(p, "url")),
        );
      },
    },
    {
      name: "browser_snapshot",
      description:
        "Distilled accessibility snapshot of an agent tab with stable element " +
        'ids ([e1], [e2], …) for click/type. Input {"targetId"}.',
      risk: "safe",
      handler: async (input) => {
        const snap = await harness.snapshot(str(parse(input), "targetId"));
        return JSON.stringify({ url: snap.url, title: snap.title, tree: snap.text });
      },
    },
    {
      name: "browser_click",
      description:
        'Click an element (by stable id) in an agent tab. Input {"targetId","elementId"}.',
      risk: "safe",
      handler: async (input) => {
        const p = parse(input);
        await harness.click(str(p, "targetId"), str(p, "elementId"));
        return JSON.stringify({ ok: true });
      },
    },
    {
      name: "browser_type",
      description:
        "Type text into an element (by stable id) in an agent tab. Refuses " +
        'password/credential fields — login is never automated. Input {"targetId","elementId","text"}.',
      risk: "safe",
      handler: async (input) => {
        const p = parse(input);
        await harness.type(str(p, "targetId"), str(p, "elementId"), str(p, "text"));
        return JSON.stringify({ ok: true });
      },
    },
    {
      name: "browser_captured_requests",
      description:
        "List the network requests this agent tab's pages made (the site's own " +
        'JSON endpoints — prefer replaying these over DOM walking). Input {"targetId","urlFilter"?}.',
      risk: "safe",
      handler: async (input) => {
        const p = parse(input);
        return JSON.stringify(
          harness.captured(
            str(p, "targetId"),
            typeof p.urlFilter === "string" ? p.urlFilter : undefined,
          ),
        );
      },
    },
    {
      name: "browser_replay_captured",
      description:
        "Re-fetch a previously captured endpoint IN PAGE (browser's own " +
        'cookies/session) and return the body. Input {"targetId","urlFilter"}.',
      risk: "safe",
      handler: async (input) => {
        const p = parse(input);
        return JSON.stringify({
          body: await harness.replayCaptured(str(p, "targetId"), str(p, "urlFilter")),
        });
      },
    },
    {
      name: "browser_close_tab",
      description: 'Close an agent tab when done with it. Input {"targetId"}.',
      risk: "safe",
      handler: async (input) => {
        await harness.closeAgentTab(str(parse(input), "targetId"));
        return JSON.stringify({ ok: true });
      },
    },
  ];

  for (const def of defs) registry.register(def);
  return defs.map((d) => d.name);
}
