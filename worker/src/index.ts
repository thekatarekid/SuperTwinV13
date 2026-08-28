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

import { runMigrations } from "./db/index.js";
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
import { startTraceRetentionJob } from "./traces/index.js";
import { startDispatcher } from "./scheduler/dispatch.js";
import { startBrainConsumer } from "./brain/consumer.js";
import { startConsolidationJob } from "./consolidation/index.js";
import { backfillTiers } from "./tiers/derive.js";
import {
  backfillBrowserStreamCategories,
  backfillChatCategories,
} from "./categories/index.js";

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
    // v13 envelopes (P0.6, spec §6.1): the adapter builds the roles envelope at
    // its boundary and carries it ON each event; the ingest writer stamps it
    // onto the row's 0100_v13_core columns — no separate sink to wire here.
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
  // v13 `browser.visit` / `browser.bookmark` events via the single-writer
  // append path (db/eventlog.ts, P0.4). Fully guarded: a machine with no
  // profiles, or a throwing append, degrades to an idle watcher / buffered
  // sink — never a boot failure.
  let browserWatcher: BrowserWatcher | null = null;
  try {
    browserWatcher = startBrowserWatcher({ log: (line) => console.error(line) });
  } catch (err) {
    console.error("[worker] browser watcher init failed (continuing):", err);
  }

  // ---- Tier backfill (P1.1, restored from V11 — §9.3 rule 4: tiering must
  // actually RUN). Code rules only at boot: engaged/passive/DM by facts,
  // business channels by content heuristics; the genuinely ambiguous ones
  // default to T2 ("unsure -> tx") until the V13 P-TI1 prompt lane lands and
  // injects a resolver. Guarded: a tiering failure must not stop the worker.
  try {
    const report = backfillTiers();
    if (report.streams > 0) {
      console.error(
        `[worker] tier backfill: ${report.assigned}/${report.streams} streams ` +
          `(T1=${report.byTier.T1} T2=${report.byTier.T2} T3=${report.byTier.T3} T4=${report.byTier.T4}` +
          `${report.defaulted.length > 0 ? `, defaulted=${report.defaulted.length}` : ""})`,
      );
    }
  } catch (err) {
    console.error("[worker] tier backfill failed (continuing):", err);
  }

  // ---- Category backfill (P1.6, spec §5.1): chat streams get their Cat-1/2
  // by code (user-reply + the cached business tier split); browser streams
  // sync from the P0.8 per-domain verdicts. Zero model calls; every change
  // writes a decisions row. Guarded: a category failure must not stop boot.
  try {
    const chat = backfillChatCategories();
    const browser = backfillBrowserStreamCategories();
    if (chat.streams + browser.streams > 0) {
      console.error(
        `[worker] category backfill: chat ${chat.byCategory.cat1}/${chat.byCategory.cat2} ` +
          `(cat1/cat2), browser ${browser.byCategory.cat1}/${browser.byCategory.cat2}` +
          `${chat.changes.length + browser.changes.length > 0 ? `, changed=${chat.changes.length + browser.changes.length}` : ""}`,
      );
    }
  } catch (err) {
    console.error("[worker] category backfill failed (continuing):", err);
  }

  // ---- Trace retention (P0.7): traces compress after 30 days (prompt/context
  // hashed + sampled full-keeps). One sweep shortly after boot, then daily.
  const traceRetention = startTraceRetentionJob();

  // ---- Dispatch windows (P0.5, spec §6.2): the 5-min window clock that turns
  // per-stream deltas into priority-ordered bundles (live > backfill A>B>C>D,
  // low-signal deferral, orphan scan). The sink is the P1.3 brain consumer:
  // digest → pack (§6.4) → Orient → Critic → single-writer commit →
  // markDispatched. Cat-2 backfill still routes to the Digest pass.
  const brainConsumer = startBrainConsumer({}, (line) => console.error(line));
  const dispatcher = startDispatcher({
    onBundle: brainConsumer.onBundle,
    log: (line) => console.error(line),
  });

  // ---- Consolidation + reduce (P1.4/P1.5, spec §6.3.2 / §15.2): every
  // minute — sweep newly-activated spaces, flag-triggered T2, drain the
  // Decide work queue; every hour — the rolling T2 (merge/split/dormancy,
  // second-look, unsorted review). Each duty is fenced inside the job.
  const consolidation = startConsolidationJob({ log: (line) => console.error(line) });

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
      dispatcher.stop();
      consolidation.stop();
      traceRetention.stop();
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
