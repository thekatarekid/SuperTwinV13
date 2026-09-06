// Worker entrypoint — V13 (P0.3 pruned tree).
//
// Boot sequence:
//   1. ensure the ~/SuperTwinV13 home layout, then run DB migrations
//      (idempotent).
//   2. register the claude-local provider (default) into the registry, and the
//      one source adapter into the ADAPTER registry — its manifest is validated
//      there, and an invalid manifest stops the boot. Adapters are STARTED only
//      by the source supervisor, on a connected consent row (V6 S1.3).
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
import { installCliGoldenRunnerIfAvailable, resetStaleGoldenRun } from "./settings/golden-gate.js";
import { claudeLocalProvider } from "./providers/claude-local/index.js";
import { registerSource } from "./adapters/registry.js";
import { WhatsAppAdapter } from "./adapters/whatsapp/adapter.js";
import { WHATSAPP_MANIFEST } from "./adapters/whatsapp/manifest.js";
import { Ingestion } from "./ingest/index.js";
import { profilesForConsent, startBrowserWatcher, type BrowserWatcher } from "./adapters/browser/index.js";
import { startScreenWatcher, type ScreenAdapter } from "./adapters/screen/index.js";
import { setSourceSupervisor, SourceSupervisor } from "./adapters/supervisor.js";
import { ensureLogsDir, teeConsole } from "./logs.js";
import { DEFAULT_WORKER_PORT, ensureHomeLayout } from "./home.js";
import { startTraceRetentionJob } from "./traces/index.js";
import { startConsolidationJob } from "./consolidation/index.js";
import { startDispatcher } from "./scheduler/v6/dispatch.js";
import { startAssistLane } from "./assist/index.js";
import { startTieringJob } from "./tiers/tiering.js";
import { startCalendarJob } from "./calendar/job.js";
import { startWakeupJob } from "./tasks/wakeups.js";
import { startBriefJob } from "./brief/job.js";
import {
  backfillBrowserStreamCategories,
  backfillChatCategories,
} from "./categories/index.js";
import { enforceHomeGuard } from "./home-guard.js";
import { startSpendHeartbeat } from "./providers/spend-heartbeat.js";
import {
  installCrashKill,
  releasePidFile,
  startParentWatch,
  sweepStaleWorkers,
} from "./process-guard.js";

async function main(): Promise<void> {
  // ---- Home guard (S0.2, T0-6; plan §1.3 rules 1 and 6): the FIRST statement.
  // A boot whose DB resolves inside ~/SuperTwinV13 is refused unless the app
  // launched us (SUPERTWIN_LAUNCHED_BY=app) or the operator waived it
  // (SUPERTWIN_ALLOW_PRODUCTION_HOME=1). Throws -> fatal -> exit 1, before the
  // home layout, migrations or any adapter is touched.
  const guard = enforceHomeGuard();

  // ---- Home layout (P0.1): ~/SuperTwinV13 with media/ logs/ browser-profile/
  // traces/ (SUPERTWIN_HOME override kept). Before migrations so the DB's
  // parent dir exists on a fresh install.
  const home = ensureHomeLayout();
  console.error(`[worker] home ${home} (${guard.reason}) pid ${process.pid} ppid ${process.ppid}`);

  // ---- Process hygiene (S0.2, T0-15): a crash kills every in-flight `claude`
  // child first; a pre-existing worker on this home is terminated and the pid
  // file claimed, so two workers never dispatch against one database.
  installCrashKill(() => claudeLocalProvider.killAll());
  const sweep = sweepStaleWorkers(home);
  if (sweep.killed !== null) console.error(`[worker] startup sweep: terminated stale worker pid ${sweep.killed}`);

  runMigrations();
  register(claudeLocalProvider);

  // ---- Golden gate (V6 P1 S5.6, SET-02): a model or reasoning change runs
  // its golden categories first, when the eval harness is on disk beside the
  // worker. A packaged app has no harness — the line says so and changes
  // apply recorded as "skipped". Only boot installs the runner: tests never
  // see it, so no unit test can reach the `claude` CLI through this seam.
  resetStaleGoldenRun();
  console.error(`[worker] ${installCliGoldenRunnerIfAvailable({ log: (line) => console.error(line) })}`);

  // ---- Spend heartbeat (S0.8, T0-13; SPD-06): `[spend] 60s: …` once a
  // minute in this log, counted at the single spawn site's completion.
  const spendHeartbeat = startSpendHeartbeat({ log: (line) => console.error(line) });

  // ---- Logs: create ~/SuperTwinV13/logs (+ /runs) and tee the node console
  // into a durable file next to the per-run transcripts (both best-effort).
  ensureLogsDir();
  teeConsole();

  // ---- Sources (V6 P1 S1.3 — the boot inversion, T4-3/T4-4/T4-8).
  //
  // Nothing captured before yes. The adapters are CONSTRUCTED here so the HTTP
  // surface can drive their connect flows, but none of them is STARTED unless
  // its source has a live 'connected' consent row: no WhatsApp daemon, no
  // browser history read, no screen sidecar on a fresh home (CNS-01). The
  // funnel gate (db/consent-gate.ts, S1.2) is the second, independent line.
  //
  // WhatsApp: EXACTLY ONE adapter is registered; its manifest is validated
  // first, and an invalid one is a BOOT ERROR — it throws out of
  // registerSource() before anything is constructed. Ingestion wiring stays
  // resilient: a missing daemon binary surfaces as status, never a boot
  // failure. SUPERTWIN_WHATSAPP_MOCK=1 passes --mock through to the daemon.
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
    // NOT adapter.connect() — the supervisor below spawns the daemon only on
    // a connected consent row, or on demand for QR pairing (POST …/pair).
  } catch (err) {
    console.error("[worker] whatsapp ingestion init failed (continuing):", err);
    ingestion = null;
    adapter = null;
  }

  // Browser (P0.8): Chrome/Safari/Arc history + bookmarks into `browser.visit`
  // / `browser.bookmark` via the single-writer. Started only under consent; the
  // import floor is the consent row's INDEX window (sinceMs is REQUIRED — the
  // 90-day default is gone, T4-4). Screen (P2.1): the screenwatch sidecar,
  // started only under consent AND after the explicit "Record from now on"
  // (app_state screen.record_from, POST /api/screen/record). Each driver is
  // guarded: a start failure is a logged skip, never a boot failure.
  let browserWatcher: BrowserWatcher | null = null;
  let screenWatcher: ScreenAdapter | null = null;
  const supervisor = new SourceSupervisor({
    log: (line) => console.error(line),
    drivers: {
      whatsapp: {
        start: async () => {
          if (!adapter) throw new Error("whatsapp adapter unavailable");
          await adapter.connect();
        },
        stop: async () => {
          if (adapter) await adapter.disconnect();
        },
      },
      browser: {
        start: (ctx) => {
          // V6 S1.4: only the profiles the consent row names (scope.profiles);
          // an empty scope means every profile discoverProfiles() finds.
          browserWatcher = startBrowserWatcher({
            sinceMs: ctx.sinceMs,
            profiles: profilesForConsent(ctx.consent),
            log: (line) => console.error(line),
          });
        },
        stop: () => {
          browserWatcher?.stop();
          browserWatcher = null;
        },
      },
      screen: {
        start: () => {
          screenWatcher = startScreenWatcher({ log: (line) => console.error(line) });
        },
        stop: async () => {
          if (screenWatcher) await screenWatcher.disconnect();
          screenWatcher = null;
        },
      },
    },
  });
  setSourceSupervisor(supervisor);
  try {
    const boot = await supervisor.startConsented();
    console.error(
      `[worker] sources: started [${boot.started.join(", ")}]` +
        `${boot.skipped.length > 0 ? ` skipped ${boot.skipped.map((s) => `${s.source}:${s.reason}`).join(" ")}` : ""}`,
    );
  } catch (err) {
    console.error("[worker] source supervisor failed (continuing):", err);
  }

  // ---- Tiering (V6 P1 S3.8, Product_V6 §11.1): one pass shortly after boot,
  // then every 15 minutes. Code decides replied-vs-not (T1 / T3 / self
  // activity); a never-replied BUSINESS costs one cached, pooled, budgeted
  // tier.v1 call — re-asked only when the channel changes character. A tier
  // moving up re-queues the stream's stamped history. Guarded inside the job:
  // a tiering failure must not stop the worker.
  const tiering = startTieringJob({ log: (line) => console.error(line) });

  // ---- Lead-time planning (V6 P1 S5.3, Product_V6 §11.9.2): a lookup tick
  // shortly after boot, then hourly — plan rows for people's dates, a space
  // opened at T minus the circle's lead time, snoozes honoured. Zero model
  // calls; guarded inside the job.
  const calendarJob = startCalendarJob({ log: (line) => console.error(line) });

  // ---- Wake-ups (V6 P1 S5.2, Product_V6 §11.12.6/11-13): the ONE clock-driven
  // job of the task layer — due scheduled steps fire (a fire slept through
  // executes on wake with its delay shown), due closure checks and past-due
  // tasks are LOOKUPS that ask "done?" by code with zero model calls, and the
  // next-step pass runs only when a closure actually wrote a trigger row.
  // Boot replays the deferred pen first. Guarded inside the job.
  const wakeups = startWakeupJob({ log: (line) => console.error(line) });

  // ---- The brief (V6 P1 S4.6, Product_V6 §14.4 item 7): one tick a minute so
  // a set time is noticed within a minute of arriving. The tick is a LOOKUP —
  // is a slot due, and did the world model move since the last brief? Nothing
  // changed means no call and no card; a set time that did move costs exactly
  // one brief.v2 call over a ledger code composed. Guarded inside the job.
  const briefJob = startBriefJob({ log: (line) => console.error(line) });

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

  // ---- Dispatch (V6 P1 S3.3, Product_V6 §11.3 / §23.2): the state gate.
  // Every 5 s the dispatcher reads new event rows, gates the live ones (open
  // task · active episode · bridge/entity in an active space · addressed to
  // the twin → HOT; ≥4 content-new on one stream in 180 s → BURST; else the
  // cold window), flushes ONE live bundle when due on the pool's reserved live
  // lane, and fills the remaining slots with history days (newest first) and
  // tier-3 weekly digests. Slot cap, keyed in-flight and revalidate-at-
  // execution are invariants of the dispatcher itself. No new event, no call.
  const dispatcher = startDispatcher({ log: (line) => console.error(line) });

  // ---- Consolidation + reduce (P1.4/P1.5, spec §6.3.2 / §15.2): every
  // minute — sweep newly-activated spaces, flag-triggered T2, drain the
  // Decide work queue; every hour — the rolling T2 (merge/split/dormancy,
  // second-look, unsorted review). Each duty is fenced inside the job.
  const consolidation = startConsolidationJob({ log: (line) => console.error(line) });

  // ---- Assist lane (P2.2, spec §10): the proactive watcher over the event-
  // log tail. Code trigger gate (novelty + cooldowns + suppression + quiet
  // hours) -> one haiku evaluator -> executor-lite -> durable artifact +
  // nudge. No capture path of its own; no risky tools in its table at all.
  const assistLane = startAssistLane({ log: (line) => console.error(line) });

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
      parentWatch.stop();
      dispatcher.stop();
      consolidation.stop();
      assistLane.stop();
      spendHeartbeat.stop();
      traceRetention.stop();
      tiering.stop();
      calendarJob.stop();
      wakeups.stop();
      briefJob.stop();
      // Every adapter the supervisor started (and the pairing daemon, if any).
      await supervisor.stopAll();
      setSourceSupervisor(null);
      // ...then stop accepting connections and let sockets drain.
      await server.close();
    } finally {
      releasePidFile(home);
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // ---- Self-shutdown (S0.2, T0-7): the parent (Tauri, scripts/dev-worker.mjs,
  // a test harness) going away starts a 10-minute countdown to a clean exit.
  // SUPERTWIN_WORKER_NO_PARENT=1 opts a deliberate headless run out.
  const parentWatch = startParentWatch({
    onParentLost: (detail) => void shutdown(`parent lost (${detail})`),
  });
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
