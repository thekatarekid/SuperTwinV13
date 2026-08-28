// ===========================================================================
// [CODE] SuperTwin Browser routes — build P3.4 (spec §12, §14.1 kill-switch).
//
//   GET  /api/browser/status            { available, running, killSwitch,
//                                         stopped, pausedSources, notices,
//                                         sessions, profileDir }
//   POST /api/browser/kill-switch       {on} → flip the flag every harness
//                                       action checks (menu-bar wiring)
//   POST /api/browser/resume            {site?} → clear a hard stop / unpause
//   GET  /api/browser/services          the "Connect your accounts" catalogue
//   POST /api/browser/connect           {service} → visible login tab
//   POST /api/browser/import-chrome     open Chromium's import-from-Chrome UI
//   POST /api/browser/health            {service} → probe session, report
//
// The manager below owns the ONE browser instance lazily: a machine without
// the staged Chromium answers every route honestly ({available:false}) rather
// than erroring — gracefully absent in dev/test by design.
// ===========================================================================

import { type IncomingMessage, type ServerResponse } from "node:http";

import { CdpClient } from "./cdp.js";
import { browserProfileDir, chromiumPath, launchChromium } from "./chromium.js";
import { BrowserHarness } from "./harness.js";
import { AccountConnector, SERVICES } from "./sessions.js";
import { SafetyController } from "./safety.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Manager — one lazily-launched browser per worker
// ---------------------------------------------------------------------------

export class BrowserManager {
  private harness: BrowserHarness | null = null;
  private connector: AccountConnector | null = null;
  private cdp: CdpClient | null = null;
  readonly safety = new SafetyController();

  get available(): boolean {
    return chromiumPath() != null;
  }

  get running(): boolean {
    return this.harness != null && this.cdp != null && !this.cdp.isClosed;
  }

  /** Launch on first use; throws the stated "unavailable" error when absent. */
  ensure(): { harness: BrowserHarness; connector: AccountConnector } {
    if (this.harness && this.connector && this.running) {
      return { harness: this.harness, connector: this.connector };
    }
    const launched = launchChromium();
    this.cdp = new CdpClient(launched.transport);
    this.harness = new BrowserHarness(this.cdp, { safety: this.safety });
    const cdp = this.cdp;
    this.connector = new AccountConnector(this.harness, {
      openUserTab: async (url: string) => {
        // A VISIBLE user tab: created un-tagged (never an agent tab) and
        // brought to the foreground for the human.
        const created = await cdp.send("Target.createTarget", { url });
        await cdp.send("Target.activateTarget", {
          targetId: created.targetId as string,
        });
      },
    });
    return { harness: this.harness, connector: this.connector };
  }

  stop(): void {
    this.cdp?.close();
    this.cdp = null;
    this.harness = null;
    this.connector = null;
  }

  status(): Record<string, unknown> {
    return {
      available: this.available,
      running: this.running,
      killSwitch: this.safety.killSwitch,
      stopped: this.safety.stopped,
      pausedSources: this.safety.pausedSources(),
      notices: this.safety.recentNotices().slice(-20),
      sessions: this.connector?.lastHealth() ?? [],
      profileDir: browserProfileDir(),
    };
  }
}

// The worker-wide singleton the server mounts. Tests build their own managers.
export const browserManager = new BrowserManager();

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function handleBrowserRoute(
  req: IncomingMessage,
  res: ServerResponse,
  manager: BrowserManager = browserManager,
): Promise<boolean> {
  const path = (req.url ?? "").split("?")[0];
  if (!path.startsWith("/api/browser/")) return false;

  try {
    if (req.method === "GET" && path === "/api/browser/status") {
      sendJson(res, 200, manager.status());
      return true;
    }

    if (req.method === "POST" && path === "/api/browser/kill-switch") {
      const body = (await readBody(req)) as { on?: unknown } | undefined;
      if (typeof body?.on !== "boolean") {
        sendJson(res, 400, { error: "body must be {on: boolean}" });
        return true;
      }
      manager.safety.setKillSwitch(body.on);
      sendJson(res, 200, { ok: true, killSwitch: manager.safety.killSwitch });
      return true;
    }

    if (req.method === "POST" && path === "/api/browser/resume") {
      const body = (await readBody(req)) as { site?: unknown } | undefined;
      manager.safety.resume(typeof body?.site === "string" ? body.site : undefined);
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (req.method === "GET" && path === "/api/browser/services") {
      sendJson(res, 200, { services: SERVICES });
      return true;
    }

    if (req.method === "POST" && path === "/api/browser/connect") {
      const body = (await readBody(req)) as { service?: unknown } | undefined;
      if (typeof body?.service !== "string") {
        sendJson(res, 400, { error: "body must be {service: string}" });
        return true;
      }
      const { connector } = manager.ensure();
      const service = await connector.startLogin(body.service);
      sendJson(res, 200, { ok: true, opened: service.loginUrl });
      return true;
    }

    if (req.method === "POST" && path === "/api/browser/import-chrome") {
      const { connector } = manager.ensure();
      await connector.startImportFromChrome();
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (req.method === "POST" && path === "/api/browser/health") {
      const body = (await readBody(req)) as { service?: unknown } | undefined;
      if (typeof body?.service !== "string") {
        sendJson(res, 400, { error: "body must be {service: string}" });
        return true;
      }
      const { connector } = manager.ensure();
      sendJson(res, 200, await connector.checkSession(body.service));
      return true;
    }

    sendJson(res, 404, { error: `no browser route: ${req.method} ${path}` });
    return true;
  } catch (err) {
    sendJson(res, 503, { error: (err as Error).message });
    return true;
  }
}
