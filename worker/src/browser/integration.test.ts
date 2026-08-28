// ===========================================================================
// Integration — build P3.4. Launches the REAL staged Chromium over the CDP
// pipe and drives the real harness against a local http server. Skipped
// automatically when no Chromium is staged (chromiumPath() === null), so unit
// CI stays green on a fresh clone; it runs in the Gates phase on a staged tree.
// ===========================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CdpClient } from "./cdp.js";
import { chromiumPath, launchChromium, type LaunchedChromium } from "./chromium.js";
import { BrowserHarness } from "./harness.js";
import { SafetyController } from "./safety.js";
import { Pacer } from "./pacing.js";

const staged = chromiumPath();
const suite = staged ? describe : describe.skip;

suite("SuperTwin Browser (real Chromium)", () => {
  let launched: LaunchedChromium;
  let cdp: CdpClient;
  let harness: BrowserHarness;
  let server: Server;
  let base: string;
  let profileDir: string;

  beforeAll(async () => {
    profileDir = mkdtempSync(join(tmpdir(), "supertwin-cft-profile-"));
    process.env.SUPERTWIN_BROWSER_PROFILE = profileDir;

    server = createServer((req, res) => {
      if ((req.url ?? "").includes("challenge")) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<title>Verify you are human</title><body>Please complete the security check.</body>");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end('<title>Hello</title><body><h1>Welcome</h1><button id="b">Go</button></body>');
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    launched = launchChromium();
    cdp = new CdpClient(launched.transport);
    harness = new BrowserHarness(cdp, {
      safety: new SafetyController(),
      pacer: new Pacer({ sleep: async () => {} }),
    });
    // Give Chromium a moment to bring the pipe up.
    await new Promise((r) => setTimeout(r, 800));
  }, 30_000);

  afterAll(() => {
    cdp?.close();
    launched?.child.kill("SIGKILL");
    server?.close();
    delete process.env.SUPERTWIN_BROWSER_PROFILE;
    rmSync(profileDir, { recursive: true, force: true });
  });

  it("navigates a real page and snapshots the button", async () => {
    const tab = await harness.createAgentTab("integration");
    const sample = await harness.navigate(tab, `${base}/ok`);
    expect(sample.title).toBe("Hello");
    const snap = await harness.snapshot(tab);
    expect(snap.nodes.some((n) => n.role === "button")).toBe(true);
    await harness.closeAgentTab(tab);
  }, 20_000);

  it("hard-stops on a real challenge page", async () => {
    const tab = await harness.createAgentTab("integration-challenge");
    await expect(harness.navigate(tab, `${base}/challenge`)).rejects.toThrow();
    expect(harness.safety.stopped?.kind).toBe("challenge");
    harness.safety.resume();
    await harness.closeAgentTab(tab).catch(() => {});
  }, 20_000);
});
