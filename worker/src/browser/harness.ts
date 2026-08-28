// ===========================================================================
// The harness — build P3.4, spec §12.4. "The hands": targets, navigation,
// click/type; "the eyes": a distilled AX snapshot with stable element ids
// (Agent-E pattern); "the memory" hooks: per-tab network capture + in-page
// replay of a site's own JSON endpoints (Libretto pattern, BRW-05).
//
// Every action passes through three code gates, in order:
//   1. SafetyController.assertRunnable() — kill-switch / standing hard stop.
//   2. AgentTabRegistry.assertAgent()    — BRW-03, user tabs are unreachable.
//   3. Pacer.run(site, …)                — BRW-02, serial + human delays.
// After every navigation the loaded page is sampled and classified; a
// challenge or login wall hard-stops the lane (BRW-01/08). All of it works
// against any RawCdpTransport, so unit tests drive it with fakes.
// ===========================================================================

import type { CdpClient, CdpEvent } from "./cdp.js";
import { AgentTabRegistry, type AgentTab } from "./tabs.js";
import {
  classifyPage,
  LoginAutomationError,
  SafetyController,
  type PageSample,
} from "./safety.js";
import { Pacer, siteOf } from "./pacing.js";

// ---------------------------------------------------------------------------
// Snapshot types
// ---------------------------------------------------------------------------

export interface SnapshotNode {
  /** Stable id (per tab): same backend node keeps the same id across
   * snapshots, so a plan made on snapshot N still names snapshot N+1. */
  id: string;
  role: string;
  name: string;
  /** Extra state worth the tokens: value, checked, disabled, url. */
  detail?: string;
  backendNodeId: number;
  depth: number;
}

export interface Snapshot {
  url: string;
  title: string;
  nodes: SnapshotNode[];
  /** Rendered, model-facing form: one line per node, indented by depth. */
  text: string;
}

export interface CapturedRequest {
  requestId: string;
  url: string;
  method: string;
  resourceType: string;
  status?: number;
  mimeType?: string;
}

export interface RunLogEntry {
  at: number;
  action: string;
  targetId?: string;
  detail?: string;
}

// Roles that carry the interaction surface — everything else is kept only
// when it has visible text (the distillation that makes 40k-node trees fit).
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "menuitem",
  "tab",
  "option",
  "listbox",
]);

const TEXT_ROLES = new Set([
  "heading",
  "StaticText",
  "text",
  "paragraph",
  "cell",
  "listitem",
  "image",
]);

interface TabState {
  sessionId: string;
  /** backendNodeId -> stable element id. */
  stableIds: Map<number, string>;
  nextStableId: number;
  network: CapturedRequest[];
  lastUrl: string;
}

const PAGE_SAMPLE_JS = `(() => ({
  url: location.href,
  title: document.title,
  bodyText: (document.body ? document.body.innerText : "").slice(0, 6000),
  hasPasswordField: !!document.querySelector('input[type="password"]'),
}))()`;

export interface HarnessDeps {
  safety?: SafetyController;
  pacer?: Pacer;
  tabs?: AgentTabRegistry;
  now?: () => number;
}

export class BrowserHarness {
  readonly safety: SafetyController;
  readonly pacer: Pacer;
  readonly tabs: AgentTabRegistry;
  /** Replayable trace of everything the agent did (spec §12.5). */
  readonly runLog: RunLogEntry[] = [];

  private readonly states = new Map<string, TabState>();
  private readonly now: () => number;

  constructor(
    private readonly cdp: CdpClient,
    deps: HarnessDeps = {},
  ) {
    this.safety = deps.safety ?? new SafetyController();
    this.pacer = deps.pacer ?? new Pacer();
    this.tabs = deps.tabs ?? new AgentTabRegistry();
    this.now = deps.now ?? Date.now;

    // Network capture is passive: record request/response summaries for every
    // agent session so replay can later hit the site's own endpoints.
    this.cdp.on("Network.requestWillBeSent", (ev) => this.onRequest(ev));
    this.cdp.on("Network.responseReceived", (ev) => this.onResponse(ev));
  }

  // -------------------------------------------------------------------------
  // Targets
  // -------------------------------------------------------------------------

  /** Read-only listing of every page target (user tabs included — listing is
   * not touching; mutation is what the registry gates). */
  async listTargets(): Promise<{ targetId: string; url: string; agent: boolean }[]> {
    const res = await this.cdp.send("Target.getTargets");
    const infos = (res.targetInfos ?? []) as {
      targetId: string;
      type: string;
      url: string;
    }[];
    return infos
      .filter((t) => t.type === "page")
      .map((t) => ({
        targetId: t.targetId,
        url: t.url,
        agent: this.tabs.isAgent(t.targetId),
      }));
  }

  /** Open a NEW agent-tagged tab. The only door into mutation. */
  async createAgentTab(purpose: string): Promise<string> {
    this.safety.assertRunnable();
    const created = await this.cdp.send("Target.createTarget", {
      url: "about:blank",
      background: true,
    });
    const targetId = created.targetId as string;
    const attached = await this.cdp.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const sessionId = attached.sessionId as string;
    const tab: AgentTab = { targetId, sessionId, createdAt: this.now(), purpose };
    this.tabs.tag(tab);
    this.states.set(targetId, {
      sessionId,
      stableIds: new Map(),
      nextStableId: 1,
      network: [],
      lastUrl: "about:blank",
    });
    await this.cdp.send("Page.enable", {}, sessionId);
    await this.cdp.send("Runtime.enable", {}, sessionId);
    await this.cdp.send("Network.enable", {}, sessionId);
    this.log("create_tab", targetId, purpose);
    return targetId;
  }

  async closeAgentTab(targetId: string): Promise<void> {
    this.tabs.assertAgent(targetId);
    await this.cdp.send("Target.closeTarget", { targetId });
    this.tabs.untag(targetId);
    this.states.delete(targetId);
    this.log("close_tab", targetId);
  }

  // -------------------------------------------------------------------------
  // Navigation (+ the BRW-01/08 checkpoint)
  // -------------------------------------------------------------------------

  async navigate(targetId: string, url: string): Promise<PageSample> {
    this.safety.assertRunnable();
    const tab = this.tabs.assertAgent(targetId);
    const site = siteOf(url);
    if (this.safety.isSourcePaused(site)) {
      throw new SourcePausedError(site);
    }
    const state = this.state(targetId);
    return this.pacer.run(site, async () => {
      // Pacing may have queued us behind an action during which a hard stop
      // landed — re-check before the request actually goes out (BRW-01: any
      // further automated request is `challenge-ignore`).
      this.safety.assertRunnable();
      this.log("navigate", targetId, url);
      const loaded = this.cdp.waitFor(
        "Page.loadEventFired",
        (ev) => ev.sessionId === tab.sessionId,
      );
      await this.cdp.send("Page.navigate", { url }, tab.sessionId);
      await loaded;
      state.lastUrl = url;
      const sample = await this.samplePage(tab.sessionId);
      this.checkpoint(sample);
      return sample;
    });
  }

  /** Classify the CURRENT page and hard-stop on challenge/login walls. Also
   * run after clicks that navigate. */
  checkpoint(sample: PageSample): void {
    const cls = classifyPage(sample);
    if (cls === "challenge") {
      this.log("hard_stop_challenge", undefined, sample.url);
      this.safety.hardStop("challenge", siteOf(sample.url), sample);
    }
    if (cls === "login") {
      this.log("hard_stop_login", undefined, sample.url);
      this.safety.hardStop("login", siteOf(sample.url), sample);
    }
  }

  async samplePage(sessionId: string): Promise<PageSample> {
    const res = await this.cdp.send(
      "Runtime.evaluate",
      { expression: PAGE_SAMPLE_JS, returnByValue: true },
      sessionId,
    );
    const value = ((res.result as { value?: unknown })?.value ?? {}) as PageSample;
    return {
      url: value.url ?? "",
      title: value.title ?? "",
      bodyText: value.bodyText ?? "",
      hasPasswordField: value.hasPasswordField === true,
    };
  }

  // -------------------------------------------------------------------------
  // The eyes: distilled AX snapshot with stable ids
  // -------------------------------------------------------------------------

  async snapshot(targetId: string): Promise<Snapshot> {
    this.safety.assertRunnable();
    const tab = this.tabs.assertAgent(targetId);
    const state = this.state(targetId);
    const res = await this.cdp.send("Accessibility.getFullAXTree", {}, tab.sessionId);
    const raw = (res.nodes ?? []) as {
      nodeId: string;
      ignored?: boolean;
      role?: { value?: string };
      name?: { value?: string };
      value?: { value?: unknown };
      backendDOMNodeId?: number;
      parentId?: string;
      childIds?: string[];
      properties?: { name: string; value?: { value?: unknown } }[];
    }[];

    // Depth from the parent chain, then distill.
    const byId = new Map(raw.map((n) => [n.nodeId, n]));
    const depthOf = (nodeId: string): number => {
      let depth = 0;
      let cur = byId.get(nodeId);
      while (cur?.parentId && byId.has(cur.parentId) && depth < 32) {
        depth++;
        cur = byId.get(cur.parentId);
      }
      return depth;
    };

    const nodes: SnapshotNode[] = [];
    for (const n of raw) {
      if (n.ignored) continue;
      const role = n.role?.value ?? "";
      const name = (n.name?.value ?? "").toString().trim();
      const interactive = INTERACTIVE_ROLES.has(role);
      const textual = TEXT_ROLES.has(role) && name.length > 0;
      if (!interactive && !textual) continue;
      if (typeof n.backendDOMNodeId !== "number") continue;

      let id = state.stableIds.get(n.backendDOMNodeId);
      if (!id) {
        id = `e${state.nextStableId++}`;
        state.stableIds.set(n.backendDOMNodeId, id);
      }

      const details: string[] = [];
      const value = n.value?.value;
      if (value != null && `${value}`.length > 0) details.push(`value=${value}`);
      for (const p of n.properties ?? []) {
        if (["checked", "disabled", "expanded", "url"].includes(p.name)) {
          details.push(`${p.name}=${p.value?.value}`);
        }
      }
      nodes.push({
        id,
        role,
        name: name.slice(0, 120),
        detail: details.length ? details.join(" ") : undefined,
        backendNodeId: n.backendDOMNodeId,
        depth: depthOf(n.nodeId),
      });
    }

    const sample = await this.samplePage(tab.sessionId);
    const minDepth = nodes.length ? Math.min(...nodes.map((n) => n.depth)) : 0;
    const text = nodes
      .map(
        (n) =>
          `${"  ".repeat(Math.min(n.depth - minDepth, 8))}[${n.id}] ${n.role}` +
          ` "${n.name}"${n.detail ? ` (${n.detail})` : ""}`,
      )
      .join("\n");
    this.log("snapshot", targetId, `${nodes.length} nodes`);
    return { url: sample.url, title: sample.title, nodes, text };
  }

  // -------------------------------------------------------------------------
  // The hands: click / type
  // -------------------------------------------------------------------------

  async click(targetId: string, elementId: string): Promise<void> {
    this.safety.assertRunnable();
    const tab = this.tabs.assertAgent(targetId);
    const state = this.state(targetId);
    const backendNodeId = this.resolveElement(state, elementId);
    await this.pacer.run(siteOf(state.lastUrl), async () => {
      this.safety.assertRunnable();
      this.log("click", targetId, elementId);
      await this.cdp.send(
        "DOM.scrollIntoViewIfNeeded",
        { backendNodeId },
        tab.sessionId,
      );
      const box = await this.cdp.send("DOM.getBoxModel", { backendNodeId }, tab.sessionId);
      const quad = ((box.model as { content?: number[] })?.content ?? []) as number[];
      const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4 || 1;
      const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4 || 1;
      for (const type of ["mousePressed", "mouseReleased"] as const) {
        await this.cdp.send(
          "Input.dispatchMouseEvent",
          { type, x, y, button: "left", clickCount: 1 },
          tab.sessionId,
        );
      }
    });
    // A click can navigate into a wall — same checkpoint as navigate.
    this.checkpoint(await this.samplePage(tab.sessionId));
  }

  /**
   * Type into an element. BRW-08 IN CODE: the target node is inspected first,
   * and a password/credential field refuses — there is no code path that puts
   * a secret into a page, no matter what any model asks for.
   */
  async type(targetId: string, elementId: string, text: string): Promise<void> {
    this.safety.assertRunnable();
    const tab = this.tabs.assertAgent(targetId);
    const state = this.state(targetId);
    const backendNodeId = this.resolveElement(state, elementId);

    const desc = await this.cdp.send("DOM.describeNode", { backendNodeId }, tab.sessionId);
    const node = (desc.node ?? {}) as { attributes?: string[] };
    const attrs = node.attributes ?? [];
    for (let i = 0; i + 1 < attrs.length; i += 2) {
      const name = attrs[i].toLowerCase();
      const value = `${attrs[i + 1]}`.toLowerCase();
      if (
        (name === "type" && value === "password") ||
        (name === "autocomplete" && value.includes("password")) ||
        (name === "name" && /passw|otp|2fa|verification.?code/.test(value))
      ) {
        this.log("refuse_credential_type", targetId, elementId);
        throw new LoginAutomationError(
          `element ${elementId} is a credential field — typing refused`,
        );
      }
    }

    await this.pacer.run(siteOf(state.lastUrl), async () => {
      this.safety.assertRunnable();
      this.log("type", targetId, `${elementId} (${text.length} chars)`);
      await this.cdp.send("DOM.focus", { backendNodeId }, tab.sessionId);
      await this.cdp.send("Input.insertText", { text }, tab.sessionId);
    });
  }

  // -------------------------------------------------------------------------
  // The memory: network capture + in-page replay (BRW-05)
  // -------------------------------------------------------------------------

  captured(targetId: string, urlFilter?: string): CapturedRequest[] {
    this.tabs.assertAgent(targetId);
    const all = this.state(targetId).network;
    return urlFilter ? all.filter((r) => r.url.includes(urlFilter)) : [...all];
  }

  /**
   * Replay a captured endpoint IN PAGE: the fetch runs inside the tab, with
   * the browser's own cookies, headers and fingerprint. The `synthetic-fetch`
   * wrong (requests outside the browser with copied cookies) cannot be
   * expressed — there is no code path from here to Node's fetch.
   */
  async replayCaptured(targetId: string, urlFilter: string): Promise<string> {
    this.safety.assertRunnable();
    const tab = this.tabs.assertAgent(targetId);
    const state = this.state(targetId);
    const hit = state.network.find((r) => r.url.includes(urlFilter));
    if (!hit) {
      throw new Error(`no captured request matching "${urlFilter}" in ${targetId}`);
    }
    return this.pacer.run(siteOf(hit.url), async () => {
      this.safety.assertRunnable();
      this.log("replay_captured", targetId, hit.url);
      const res = await this.cdp.send(
        "Runtime.evaluate",
        {
          expression: `fetch(${JSON.stringify(hit.url)}, { credentials: "include" })
            .then((r) => r.text())`,
          awaitPromise: true,
          returnByValue: true,
        },
        tab.sessionId,
      );
      return `${(res.result as { value?: unknown })?.value ?? ""}`;
    });
  }

  // -------------------------------------------------------------------------

  private state(targetId: string): TabState {
    const s = this.states.get(targetId);
    if (!s) throw new Error(`no harness state for target ${targetId}`);
    return s;
  }

  private resolveElement(state: TabState, elementId: string): number {
    for (const [backendNodeId, id] of state.stableIds) {
      if (id === elementId) return backendNodeId;
    }
    throw new Error(`unknown element id ${elementId} — take a fresh snapshot`);
  }

  private sessionTarget(sessionId: string | undefined): string | null {
    if (!sessionId) return null;
    for (const [targetId, s] of this.states) {
      if (s.sessionId === sessionId) return targetId;
    }
    return null;
  }

  private onRequest(ev: CdpEvent): void {
    const targetId = this.sessionTarget(ev.sessionId);
    if (!targetId) return;
    const p = ev.params as {
      requestId?: string;
      type?: string;
      request?: { url?: string; method?: string };
    };
    this.state(targetId).network.push({
      requestId: p.requestId ?? "",
      url: p.request?.url ?? "",
      method: p.request?.method ?? "GET",
      resourceType: p.type ?? "Other",
    });
  }

  private onResponse(ev: CdpEvent): void {
    const targetId = this.sessionTarget(ev.sessionId);
    if (!targetId) return;
    const p = ev.params as {
      requestId?: string;
      response?: { status?: number; mimeType?: string };
    };
    const rec = this.state(targetId).network.find((r) => r.requestId === p.requestId);
    if (rec) {
      rec.status = p.response?.status;
      rec.mimeType = p.response?.mimeType;
    }
  }

  private log(action: string, targetId?: string, detail?: string): void {
    this.runLog.push({ at: this.now(), action, targetId, detail });
  }
}

/** A paused source refuses navigation until a human resumes it (BRW-01). */
export class SourcePausedError extends Error {
  constructor(site: string) {
    super(
      `source ${site} is paused (previous challenge/login stop) — ` +
        `resume it manually before the agent may browse there again`,
    );
    this.name = "SourcePausedError";
  }
}
