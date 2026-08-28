// ===========================================================================
// SuperTwin Browser core — build P3.4 code-asserted safety (spec §12, evals
// BRW-01/02/03/05/08). No real Chromium: the harness runs against
// FakeCdpTransport, and the "local test HTTP server simulating challenge
// pages" the task calls for is a real in-process http.Server the classifier
// reads over the wire (challengeServer below), proving the detector fires on
// live-served HTML, not just literals.
// ===========================================================================

import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

import { CdpClient } from "./cdp.js";
import { FakeCdpTransport, makeHarnessResponder } from "./fake-cdp.js";
import { BrowserHarness } from "./harness.js";
import { SafetyController, BrowserHardStopError, LoginAutomationError, classifyPage } from "./safety.js";
import { Pacer, siteOf } from "./pacing.js";
import { AgentTabRegistry, TabIsolationError } from "./tabs.js";
import { ToolRegistry } from "../executor/tools.js";
import { registerBrowserTools } from "./tools.js";

// In-memory flags so no DB is needed (SafetyController takes injectable
// storage); the pause decisions-row write is swallowed by the controller when
// no DB is present, which these tests rely on.
function memSafety(notify?: (n: unknown) => void): SafetyController {
  const store = new Map<string, string>();
  return new SafetyController({
    getFlag: (k) => store.get(k) ?? null,
    setFlag: (k, v) => void store.set(k, v),
    notify: notify as never,
    writeDecision: (() => "dec_x") as never,
  });
}

function makeHarness(
  pages: Parameters<typeof makeHarnessResponder>[0],
  opts: { safety?: SafetyController; pacer?: Pacer } = {},
): { harness: BrowserHarness; transport: FakeCdpTransport } {
  const wired = makeHarnessResponder(pages);
  const transport = new FakeCdpTransport(wired.responder);
  wired.setTransport(transport);
  const cdp = new CdpClient(transport);
  const harness = new BrowserHarness(cdp, {
    safety: opts.safety ?? memSafety(),
    pacer: opts.pacer ?? new Pacer({ sleep: async () => {}, rng: () => 0.5 }),
    now: () => 1000,
  });
  return { harness, transport };
}

// A zero-delay pacer keeps async tests fast without losing serialization.
const fastPacer = () => new Pacer({ sleep: async () => {}, rng: () => 0.5 });

let servers: Server[] = [];
afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
});

// ---------------------------------------------------------------------------
// BRW-01 — challenge page = hard stop
// ---------------------------------------------------------------------------

describe("BRW-01 · challenge page = hard stop", () => {
  it("halts immediately, preserves session, pauses source, notifies with evidence", async () => {
    const notices: unknown[] = [];
    const safety = memSafety((n) => notices.push(n));
    const { harness, transport } = makeHarness(
      {
        "https://x.com/i/bookmarks": {
          title: "Verify you are human",
          bodyText: "Please complete the security check to continue.",
        },
      },
      { safety },
    );
    const tab = await harness.createAgentTab("x bookmarks read");
    const before = transport.sent.length;

    await expect(harness.navigate(tab, "https://x.com/i/bookmarks")).rejects.toThrow(
      BrowserHardStopError,
    );

    // No retry / no solve attempt: nothing more went to the wire after the stop.
    expect(safety.stopped?.kind).toBe("challenge");
    expect(safety.pausedSources()).toContain("x.com");
    expect(notices).toHaveLength(1);
    expect((notices[0] as { sample?: unknown }).sample).toBeTruthy();

    // BRW-01: any further automated request is challenge-ignore — blocked.
    const sentDuringStop = transport.sent.length;
    await expect(harness.navigate(tab, "https://x.com/i/bookmarks")).rejects.toThrow(
      /hard-stopped|paused/,
    );
    // The blocked navigate issued no new CDP commands past the guard.
    expect(transport.sent.length).toBe(sentDuringStop);
    expect(before).toBeGreaterThan(0);
  });

  it("stays stopped until a human resumes, then runs again", async () => {
    const safety = memSafety();
    const { harness } = makeHarness(
      {
        "https://x.com/a": { title: "checking your browser", bodyText: "" },
        "https://x.com/ok": { title: "Home", bodyText: "your timeline" },
      },
      { safety },
    );
    const tab = await harness.createAgentTab("x");
    await expect(harness.navigate(tab, "https://x.com/a")).rejects.toThrow();
    expect(safety.stopped).not.toBeNull();
    safety.resume("x.com");
    expect(safety.stopped).toBeNull();
    const sample = await harness.navigate(tab, "https://x.com/ok");
    expect(sample.title).toBe("Home");
  });

  it("classifies challenge HTML served by a real local http server", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><title>Just a moment…</title><body>Attention Required! Cloudflare — checking your browser before accessing.</body></html>");
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/`;
    const html = await (await fetch(url)).text();
    const titleMatch = /<title>([^<]*)<\/title>/.exec(html);
    expect(
      classifyPage({ url, title: titleMatch?.[1] ?? "", bodyText: html }),
    ).toBe("challenge");
  });
});

// ---------------------------------------------------------------------------
// BRW-02 — human pacing + jitter (code)
// ---------------------------------------------------------------------------

describe("BRW-02 · human pacing + jitter", () => {
  it("jitters fire times, skips days, stays in active hours over 14 days", () => {
    let seed = 12345;
    const rng = () => {
      // Deterministic LCG so the assertions are stable.
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pacer = new Pacer({ rng });
    const runs = pacer.scheduleDailyRuns(9, 14);

    const fired = runs.filter((r) => r.fireAtMs != null);
    const skipped = runs.filter((r) => r.fireAtMs == null);
    expect(skipped.length).toBeGreaterThan(0); // random skip days present
    expect(fired.length).toBeGreaterThan(0);

    const times = fired.map((r) => r.fireAtMs as number);
    // Not a metronome: fire offsets vary across days.
    expect(new Set(times).size).toBeGreaterThan(1);
    // ±30 min around 09:00, clamped to active hours.
    for (const t of times) {
      expect(t).toBeGreaterThanOrEqual(8 * 3_600_000);
      expect(t).toBeLessThan(23 * 3_600_000);
      expect(Math.abs(t - 9 * 3_600_000)).toBeLessThanOrEqual(30 * 60_000);
    }
  });

  it("inter-action delays are human-scale and non-uniform", () => {
    const pacer = new Pacer({ rng: (() => {
      const xs = [0.01, 0.5, 0.99, 0.2, 0.8];
      let i = 0;
      return () => xs[i++ % xs.length];
    })() });
    const delays = Array.from({ length: 5 }, () => pacer.nextActionDelayMs());
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(900);
      expect(d).toBeLessThanOrEqual(6500);
    }
    expect(new Set(delays).size).toBeGreaterThan(1); // not identical
  });

  it("serializes same-site actions — never parallel requests to one site", async () => {
    const pacer = new Pacer({ sleep: async () => {}, rng: () => 0.5 });
    const order: string[] = [];
    let inFlight = 0;
    let maxConcurrent = 0;
    const task = (label: string) =>
      pacer.run("x.com", async () => {
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        order.push(`start ${label}`);
        await Promise.resolve();
        order.push(`end ${label}`);
        inFlight--;
      });
    await Promise.all([task("a"), task("b"), task("c")]);
    expect(maxConcurrent).toBe(1);
    expect(order).toEqual([
      "start a", "end a", "start b", "end b", "start c", "end c",
    ]);
  });
});

// ---------------------------------------------------------------------------
// BRW-03 — agent tabs never touch user tabs
// ---------------------------------------------------------------------------

describe("BRW-03 · agent tabs never touch user tabs", () => {
  it("refuses every mutation on an untagged (user) target", async () => {
    const { harness } = makeHarness({ "https://news/a": { title: "Article", bodyText: "read" } });
    const userTarget = "USER_TAB_1"; // never created through createAgentTab
    await expect(harness.navigate(userTarget, "https://news/a")).rejects.toThrow(
      TabIsolationError,
    );
    await expect(harness.click(userTarget, "e1")).rejects.toThrow(TabIsolationError);
    await expect(harness.type(userTarget, "e1", "hi")).rejects.toThrow(TabIsolationError);
    await expect(harness.snapshot(userTarget)).rejects.toThrow(TabIsolationError);
    await expect(harness.closeAgentTab(userTarget)).rejects.toThrow(TabIsolationError);
  });

  it("only touches its own tab; listing shows the isolation", async () => {
    const registry = new AgentTabRegistry();
    const { harness } = makeHarness({ "https://x.com/ok": { title: "ok", bodyText: "ok" } });
    // Swap in a shared registry to inspect tags.
    (harness as unknown as { tabs: AgentTabRegistry }).tabs = registry;
    const tab = await harness.createAgentTab("agent work");
    expect(registry.isAgent(tab)).toBe(true);
    expect(registry.isAgent("USER_TAB_1")).toBe(false);
    // The run log is the replay trace showing what the agent touched.
    expect(harness.runLog.some((e) => e.action === "create_tab")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BRW-05 — captured-API replay over DOM walking
// ---------------------------------------------------------------------------

describe("BRW-05 · captured-API replay over DOM walking", () => {
  it("replays a captured endpoint IN PAGE with the browser's own session", async () => {
    const { harness, transport } = makeHarness({
      "https://goibibo.com/villas": {
        title: "Villas",
        bodyText: "listing results json",
      },
    });
    const tab = await harness.createAgentTab("villa compare");
    await harness.navigate(tab, "https://goibibo.com/villas");

    // Simulate the site's own XHR being observed during the first run.
    const session = harness.tabs.assertAgent(tab).sessionId;
    transport.emit(
      "Network.requestWillBeSent",
      {
        requestId: "R1",
        type: "XHR",
        request: { url: "https://goibibo.com/api/listings?city=goa", method: "GET" },
      },
      session,
    );
    await Promise.resolve();

    const captured = harness.captured(tab, "/api/listings");
    expect(captured).toHaveLength(1);

    const body = await harness.replayCaptured(tab, "/api/listings");
    expect(body).toBe("listing results json");

    // The replay is an in-page fetch (credentials:"include") — NOT a Node
    // fetch with copied cookies (synthetic-fetch). Assert the CDP command.
    const evalCmd = transport.sent.find(
      (c) => c.method === "Runtime.evaluate" &&
        String(c.params.expression).includes("fetch("),
    );
    expect(evalCmd).toBeTruthy();
    expect(String(evalCmd?.params.expression)).toContain('credentials: "include"');
  });
});

// ---------------------------------------------------------------------------
// BRW-08 — login is never automated
// ---------------------------------------------------------------------------

describe("BRW-08 · login is never automated", () => {
  it("hard-stops on a login wall and notifies the user to sign in", async () => {
    const notices: { kind?: string; message?: string }[] = [];
    const safety = memSafety((n) => notices.push(n as never));
    const { harness } = makeHarness(
      {
        "https://www.instagram.com/": {
          title: "Login • Instagram",
          bodyText: "Please log in to continue. Enter your password.",
          hasPasswordField: true,
        },
      },
      { safety },
    );
    const tab = await harness.createAgentTab("ig saved read");
    await expect(harness.navigate(tab, "https://www.instagram.com/")).rejects.toThrow(
      BrowserHardStopError,
    );
    expect(safety.stopped?.kind).toBe("login");
    expect(notices[0]?.message).toMatch(/sign in|open the browser/i);
  });

  it("refuses to type into a credential field — no auto-login tool exists", async () => {
    const { harness } = makeHarness({
      "https://x.com/settings": {
        title: "Settings",
        bodyText: "your account settings",
        axNodes: [],
        attributesByBackendId: { 7: ["type", "password"] },
      },
    });
    const tab = await harness.createAgentTab("x");
    await harness.navigate(tab, "https://x.com/settings");
    // Wire a stable id to the (page's) password backend node.
    const state = (harness as unknown as {
      states: Map<string, { stableIds: Map<number, string> }>;
    }).states.get(tab)!;
    state.stableIds.set(7, "e1");
    await expect(harness.type(tab, "e1", "hunter2")).rejects.toThrow(
      LoginAutomationError,
    );
  });

  it("the tool registry exposes NO credential/send/payment tool", () => {
    const wired = makeHarnessResponder({});
    const transport = new FakeCdpTransport(wired.responder);
    wired.setTransport(transport);
    const harness = new BrowserHarness(new CdpClient(transport), {
      safety: memSafety(),
      pacer: fastPacer(),
    });
    const registry = new ToolRegistry();
    const names = registerBrowserTools(registry, harness);
    // The COMPLETE surface — nothing that logs in, sends, or pays.
    for (const n of names) {
      expect(n).not.toMatch(/login|credential|password|send|pay|purchase|book/i);
    }
    // All browser tools are risk "safe" (the registry itself would refuse a
    // "safe" tool whose name read as risky — EXE-04).
    expect(registry.list().every((t) => t.risk === "safe")).toBe(true);
    expect(names).toContain("browser_navigate");
    expect(names).toContain("browser_replay_captured");
  });
});

// ---------------------------------------------------------------------------
// Kill-switch (spec §12.5/§14.1) — the menu-bar flag every action honors
// ---------------------------------------------------------------------------

describe("kill-switch", () => {
  it("blocks all harness actions while on, runs again once off", async () => {
    const safety = memSafety();
    const { harness } = makeHarness(
      { "https://x.com/ok": { title: "ok", bodyText: "ok" } },
      { safety },
    );
    const tab = await harness.createAgentTab("x");
    safety.setKillSwitch(true);
    await expect(harness.navigate(tab, "https://x.com/ok")).rejects.toThrow(
      /kill-switch/,
    );
    safety.setKillSwitch(false);
    await expect(harness.navigate(tab, "https://x.com/ok")).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Distilled AX snapshot with stable ids (spec §12.4 "the eyes")
// ---------------------------------------------------------------------------

describe("distilled AX snapshot", () => {
  it("keeps interactive + text nodes, assigns stable ids across snapshots", async () => {
    const axNodes = [
      { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Home" }, backendDOMNodeId: 1, childIds: ["2", "3"] },
      { nodeId: "2", role: { value: "button" }, name: { value: "Search" }, backendDOMNodeId: 2, parentId: "1" },
      { nodeId: "3", role: { value: "heading" }, name: { value: "Results" }, backendDOMNodeId: 3, parentId: "1" },
      { nodeId: "4", role: { value: "generic" }, name: { value: "" }, backendDOMNodeId: 4, parentId: "1" },
    ];
    const { harness } = makeHarness({
      "https://x.com/home": { title: "Home", bodyText: "home", axNodes },
    });
    const tab = await harness.createAgentTab("x");
    await harness.navigate(tab, "https://x.com/home");
    const snap1 = await harness.snapshot(tab);
    // generic empty node dropped; button + heading kept.
    expect(snap1.nodes.map((n) => n.role).sort()).toEqual(["button", "heading"]);
    const searchId = snap1.nodes.find((n) => n.name === "Search")!.id;
    expect(snap1.text).toContain(`[${searchId}] button "Search"`);
    // Stable across a re-snapshot (same backend node → same id).
    const snap2 = await harness.snapshot(tab);
    expect(snap2.nodes.find((n) => n.name === "Search")!.id).toBe(searchId);
  });
});

describe("siteOf", () => {
  it("normalizes to a registrable-ish host, drops www", () => {
    expect(siteOf("https://www.x.com/i/bookmarks")).toBe("x.com");
    expect(siteOf("https://goibibo.com/a?b=1")).toBe("goibibo.com");
    expect(siteOf("not a url")).toBe("invalid");
  });
});
