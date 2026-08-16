// Worker entrypoint.
//
// Boot sequence (docs/PHASE0_ARCHITECTURE.md §7, §9):
//   1. run DB migrations (idempotent).
//   2. register the claude-local provider (default) into the registry, and the
//      one source adapter into the ADAPTER registry — its manifest is validated
//      there, and an invalid manifest stops the boot (arch §2.2).
//   3. start the HTTP/SSE server, which prints exactly
//      `WORKER_READY port=<port>` to stdout so Tauri + tests detect readiness.
//   4. on SIGINT/SIGTERM: close the server and kill any in-flight `claude`
//      children, then exit clean (kill-switch foundation — no orphans).
//
// V8 scope: Phase 0 (provider + chat) + Phase 1 (WhatsApp ingestion) + grounded
// chat retrieval. There is no extraction engine, executor, scheduler or nightly
// runner — messages are ingested and served, and chat grounds itself with FTS
// over those events at query time.

import { runMigrations } from "./db/index.js";
import { runStartupCalibration } from "./retrieval/calibration.js";
import { startServer, type ServerHandle } from "./server/index.js";
import { register } from "./providers/index.js";
import { claudeLocalProvider } from "./providers/claude-local/index.js";
import { registerSource } from "./adapters/registry.js";
import { WhatsAppAdapter } from "./adapters/whatsapp/adapter.js";
import { WHATSAPP_MANIFEST } from "./adapters/whatsapp/manifest.js";
import { Ingestion } from "./ingest/index.js";
import { ensureLogsDir, teeConsole } from "./logs.js";

async function main(): Promise<void> {
  runMigrations();
  register(claudeLocalProvider);

  // ---- Logs: create ~/SuperTwinV11/logs (+ /runs) and tee the node console into a
  // durable file next to the per-run transcripts (both best-effort; §9).
  ensureLogsDir();
  teeConsole();

  // ---- Embedder calibration (item 0.7, arch §10.3). Measures the
  // unrelated-pair floor per (model, use_case) from the vectors already
  // stored. On a cold install every use case reports "insufficient-vectors"
  // and the [ML] similarity rung stays DISABLED — which is the correct boot
  // state, not a failure. Best-effort: a calibration error must not stop the
  // worker from serving.
  try {
    const calib = runStartupCalibration();
    console.error(
      `[worker] embedder calibration (${calib.model}): ` +
        (calib.enabled.length > 0
          ? `[ML] similarity enabled for ${calib.enabled.join(", ")}`
          : "no use case calibrated yet — [ML] similarity disabled"),
    );
  } catch (err) {
    console.error("[worker] embedder calibration failed (similarity stays disabled):", err);
  }

  // ---- Sources. EXACTLY ONE adapter is registered (arch §2.2 note 5, build
  // item 1.1): the manifest is validated first, and an invalid one is a BOOT
  // ERROR — it throws out of registerSource() before anything is constructed.
  // Nothing in the core may construct an adapter directly any more; that
  // direct `new WhatsAppAdapter()` was the leak this replaces (§3.3 leak 5).
  //
  // Ingestion itself stays resilient: if the daemon binary is missing (dev),
  // the adapter surfaces an error status but the worker still boots + serves the
  // API. SUPERTWIN_WHATSAPP_MOCK=1 passes --mock through to the daemon.
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
    ingestion = new Ingestion(adapter, { manifest: registered.manifest });
    ingestion.start();
    // connect() spawns the daemon; a spawn failure is surfaced as status, not a
    // throw, so we don't guard the await beyond the outer try/catch.
    await adapter.connect();
  } catch (err) {
    console.error("[worker] whatsapp ingestion init failed (continuing):", err);
    ingestion = null;
    adapter = null;
  }

  const port = Number(process.env.SUPERTWIN_WORKER_PORT ?? 8011);
  const server: ServerHandle = await startServer({ port, ingestion });

  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[worker] ${sig} received — shutting down`);
    try {
      // Kill any live children so nothing is orphaned...
      claudeLocalProvider.killAll();
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
  process.exitCode = 1;
});
