// Worker entrypoint — V13 (P0.3 pruned tree).
//
// Boot sequence:
//   1. ensure the ~/SuperTwinV13 home layout, then run DB migrations
//      (idempotent).
//   2. register the claude-local provider (default) into the registry, and the
//      one source adapter into the ADAPTER registry — its manifest is validated
//      there, and an invalid manifest stops the boot.
//   3. start the HTTP/SSE server, which prints exactly
//      `WORKER_READY port=<port>` to stdout so Tauri + tests detect readiness.
//      /api/health answers as soon as this line is printed.
//   4. on SIGINT/SIGTERM: close the server and kill any in-flight `claude`
//      children, then exit clean (no orphans).
//
// The V11 derivation middle (sessions -> episodes -> arcs, claims, bootstrap +
// steady drivers, embedder calibration, tier ensure) was deleted in P0.3; the
// V13 pipeline lands in P0.4+ (event log, cursors/windows, orient/understand).

import { runMigrations, getDb } from "./db/index.js";
import { startServer, type ServerHandle } from "./server/index.js";
import { register } from "./providers/index.js";
import { claudeLocalProvider } from "./providers/claude-local/index.js";
import { registerSource } from "./adapters/registry.js";
import { WhatsAppAdapter } from "./adapters/whatsapp/adapter.js";
import { WHATSAPP_MANIFEST } from "./adapters/whatsapp/manifest.js";
import { Ingestion } from "./ingest/index.js";
import { startBrowserWatcher, type BrowserWatcher } from "./adapters/browser/index.js";
import { ensureLogsDir, teeConsole } from "./logs.js";
import { DEFAULT_WORKER_PORT, ensureHomeLayout } from "./home.js";

async function main(): Promise<void> {
  // ---- Home layout (P0.1): ~/SuperTwinV13 with media/ logs/ browser-profile/
  // traces/ (SUPERTWIN_HOME override kept). Before migrations so the DB's
  // parent dir exists on a fresh install.
  ensureHomeLayout();
  runMigrations();
  register(claudeLocalProvider);

  // ---- Logs: create ~/SuperTwinV13/logs (+ /runs) and tee the node console
  // into a durable file next to the per-run transcripts (both best-effort).
  ensureLogsDir();
  teeConsole();

  // ---- Sources. EXACTLY ONE adapter is registered: the manifest is validated
  // first, and an invalid one is a BOOT ERROR — it throws out of
  // registerSource() before anything is constructed.
  //
  // Ingestion itself stays resilient: if the daemon binary is missing (dev),
  // the adapter surfaces an error status but the worker still boots + serves
  // the API. SUPERTWIN_WHATSAPP_MOCK=1 passes --mock through to the daemon.
  let ingestion: Ingestion | null = null;
  let adapter: WhatsAppAdapter | null = null;
  const registered = registerSource({
    manifest: WHATSAPP_MANIFEST,
    adapter: new WhatsAppAdapter({
      mock: process.env.SUPERTWIN_WHATSAPP_MOCK === "1",
      log: (line) => console.error(line),
    }),
  });
  try {
    adapter = registered.adapter as WhatsAppAdapter;
    ingestion = new Ingestion(adapter, {
      manifest: registered.manifest,
      log: (line) => console.error(line),
    });
    ingestion.start();
    // connect() spawns the daemon; a spawn failure is surfaced as status, not a
    // throw, so we don't guard the await beyond the outer try/catch.
    await adapter.connect();
  } catch (err) {
    console.error("[worker] whatsapp ingestion init failed (continuing):", err);
    ingestion = null;
    adapter = null;
  }

  // ---- Browser watcher (P0.8): Chrome/Safari/Arc history + bookmarks into
  // v13 `browser.visit` / `browser.bookmark` events. Fully guarded: a machine
  // with no profiles, or a DB where 0100_v13_core has not landed yet, degrades
  // to an idle watcher / buffered sink — never a boot failure.
  let browserWatcher: BrowserWatcher | null = null;
  try {
    browserWatcher = startBrowserWatcher(getDb(), { log: (line) => console.error(line) });
  } catch (err) {
    console.error("[worker] browser watcher init failed (continuing):", err);
  }

  const port = Number(process.env.SUPERTWIN_WORKER_PORT ?? DEFAULT_WORKER_PORT);
  const server: ServerHandle = await startServer({ port, ingestion });

  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[worker] ${sig} received — shutting down`);
    try {
      // Kill any live children so nothing is orphaned...
      claudeLocalProvider.killAll();
      browserWatcher?.stop();
      if (adapter) await adapter.disconnect();
      // ...then stop accepting connections and let sockets drain.
      await server.close();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
