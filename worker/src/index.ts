// Worker entrypoint — V13 (P0.3 pruned tree).
//
// Boot sequence — TWO PHASES, and the order between them is the contract
// (V6 P1 W1; boot-guard.ts carries the reasoning):
//
//   PHASE 1, hard rails. A failure here MUST stop the boot.
//   1. the home guard (plan §1.3 rules 1 and 6), the ~/SuperTwinV13 home
//      layout, the crash-kill hook, the stale-worker sweep + pid claim, then
//      DB migrations (idempotent).
//   2. register the claude-local provider (default) into the registry, and the
//      one source adapter into the ADAPTER registry — its manifest is validated
//      there, and an invalid manifest stops the boot. Adapters are STARTED only
//      by the source supervisor, on a connected consent row (V6 S1.3).
//   3. start the HTTP/SSE server, which prints exactly
//      `WORKER_READY port=<port>` to stdout so Tauri + tests detect readiness.
//      /api/health answers as soon as this line is printed.
//
//   PHASE 2, optional subsystems — AFTER the listener, each one wrapped in
//   optionalStep(). Jobs, watchers, backfills and the golden gate degrade to a
//   logged line and a name on /api/health's `degraded` list instead of taking
//   the process down. 13.11.1 and 13.11.2 shipped with the golden gate ahead of
//   the listener, and one throw inside it meant the whole app said "worker
//   unreachable" — this split is that bug's fix.
//
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
import { startLibraryMaintenance } from "./library/maintenance.js";
import { startTraceRetentionJob } from "./traces/index.js";
import { startConsolidationJob } from "./consolidation/index.js";
import { startDispatcher } from "./scheduler/v6/dispatch.js";
import { startTieringJob } from "./tiers/tiering.js";
import { startCalendarJob } from "./calendar/job.js";
import { startWakeupJob } from "./tasks/wakeups.js";
import { startBriefJob } from "./brief/job.js";
import { startPreparedQueueJob } from "./executor/queue-job.js";
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
import { degradedSubsystems, optionalStep, optionalStepAsync } from "./boot-guard.js";

async function main(): Promise<void> {
  // Every subsystem logs through the same sink; teeConsole() below duplicates
  // it into ~/SuperTwinV13/logs once the home layout exists.
  const log = (line: string): void => console.error(line);

  // ---- Home guard (S0.2, T0-6; plan §1.3 rules 1 and 6): the FIRST rail.
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

  // ---- Logs: create ~/SuperTwinV13/logs (+ /runs) and tee the node console
  // into a durable file next to the per-run transcripts. Best-effort by design
  // — a read-only or full disk costs the log file, never the worker.
  optionalStep("logs", () => {
    ensureLogsDir();
    teeConsole();
  }, { log });

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
  // registerSource() before anything is constructed, deliberately, because a
  // malformed manifest is a build defect and not a runtime condition.
  // Ingestion wiring is the part that stays resilient: a missing daemon binary
  // surfaces as status, never a boot failure. SUPERTWIN_WHATSAPP_MOCK=1 passes
  // --mock through to the daemon.
  const registered = registerSource({
    manifest: WHATSAPP_MANIFEST,
    adapter: new WhatsAppAdapter({
      mock: process.env.SUPERTWIN_WHATSAPP_MOCK === "1",
      log,
    }),
  });
  const wiring = optionalStep("whatsapp ingestion", () => {
    const whatsapp = registered.adapter as WhatsAppAdapter;
    // v13 envelopes (P0.6, spec §6.1): the adapter builds the roles envelope at
    // its boundary and carries it ON each event; the ingest writer stamps it
    // onto the row's 0100_v13_core columns — no separate sink to wire here.
    const ingest = new Ingestion(whatsapp, { manifest: registered.manifest, log });
    ingest.start();
    // NOT adapter.connect() — the supervisor below spawns the daemon only on
    // a connected consent row, or on demand for QR pairing (POST …/pair).
    return { adapter: whatsapp, ingestion: ingest };
  }, { log });
  const adapter: WhatsAppAdapter | null = wiring?.adapter ?? null;
  const ingestion: Ingestion | null = wiring?.ingestion ?? null;

  // Browser (P0.8): Chrome/Safari/Arc history + bookmarks into `browser.visit`
  // / `browser.bookmark` via the single-writer. Started only under consent; the
  // import floor is the consent row's INDEX window (sinceMs is REQUIRED — the
  // 90-day default is gone, T4-4). Screen (P2.1): the screenwatch sidecar,
  // started only under consent AND after the explicit "Record from now on"
  // (app_state screen.record_from, POST /api/screen/record). Each driver is
  // guarded: a start failure is a logged skip, never a boot failure.
  //
  // The supervisor is CONSTRUCTED (and registered for the routes to find)
  // before the listener because it costs nothing and a request that arrives in
  // the first millisecond should not see a null one. It is STARTED below, on
  // the optional side of the line.
  let browserWatcher: BrowserWatcher | null = null;
  let screenWatcher: ScreenAdapter | null = null;
  const supervisor = new SourceSupervisor({
    log,
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
            log,
          });
        },
        stop: () => {
          browserWatcher?.stop();
          browserWatcher = null;
        },
      },
      screen: {
        start: () => {
          screenWatcher = startScreenWatcher({ log });
        },
        stop: async () => {
          if (screenWatcher) await screenWatcher.disconnect();
          screenWatcher = null;
        },
      },
    },
  });
  setSourceSupervisor(supervisor);

  // =========================================================================
  // THE LISTENER. Everything above is a hard rail; everything below is
  // optional and cannot take the process down (W1). /api/health answers from
  // this line on, so a subsystem that fails degrades the app instead of
  // bricking it — and says which one, on /api/health.
  // =========================================================================
  const port = Number(process.env.SUPERTWIN_WORKER_PORT ?? DEFAULT_WORKER_PORT);
  const server: ServerHandle = await startServer({ port, ingestion });

  // ---- Golden gate (V6 P1 S5.6, SET-02): a model or reasoning change runs
  // its golden categories first, when the eval harness is on disk beside the
  // worker. A packaged app has no harness — the line says so and changes
  // apply recorded as "skipped". Only boot installs the runner: tests never
  // see it, so no unit test can reach the `claude` CLI through this seam.
  //
  // This is the step that shipped the 13.11.1/13.11.2 boot crash. It is
  // optional by its own name, and it is now BOTH after the listener and
  // wrapped.
  optionalStep("golden gate", () => {
    resetStaleGoldenRun();
    console.error(`[worker] ${installCliGoldenRunnerIfAvailable({ log })}`);
  }, { log });

  // ---- Spend heartbeat (S0.8, T0-13; SPD-06): `[spend] 60s: …` once a
  // minute in this log, counted at the single spawn site's completion.
  const spendHeartbeat = optionalStep("spend heartbeat", () => startSpendHeartbeat({ log }), { log });

  // ---- Sources: START what consent already allows (nothing, on a fresh home).
  await optionalStepAsync("source supervisor", async () => {
    const boot = await supervisor.startConsented();
    console.error(
      `[worker] sources: started [${boot.started.join(", ")}]` +
        `${boot.skipped.length > 0 ? ` skipped ${boot.skipped.map((s) => `${s.source}:${s.reason}`).join(" ")}` : ""}`,
    );
  }, { log });

  // ---- Tiering (V6 P1 S3.8, Product_V6 §11.1): one pass shortly after boot,
  // then every 15 minutes. Code decides replied-vs-not (T1 / T3 / self
  // activity); a never-replied BUSINESS costs one cached, pooled, budgeted
  // tier.v1 call — re-asked only when the channel changes character. A tier
  // moving up re-queues the stream's stamped history. Guarded inside the job
  // as well: a tiering failure must not stop the worker.
  const tiering = optionalStep("tiering", () => startTieringJob({ log }), { log });

  // ---- Lead-time planning (V6 P1 S5.3, Product_V6 §11.9.2): a lookup tick
  // shortly after boot, then hourly — plan rows for people's dates, a space
  // opened at T minus the circle's lead time, snoozes honoured. Zero model
  // calls; guarded inside the job.
  const calendarJob = optionalStep("calendar", () => startCalendarJob({ log }), { log });

  // ---- Wake-ups (V6 P1 S5.2, Product_V6 §11.12.6/11-13): the ONE clock-driven
  // job of the task layer — due scheduled steps fire (a fire slept through
  // executes on wake with its delay shown), due closure checks and past-due
  // tasks are LOOKUPS that ask "done?" by code with zero model calls, and the
  // next-step pass runs only when a closure actually wrote a trigger row.
  // Boot replays the deferred pen first. Guarded inside the job.
  const wakeups = optionalStep("wake-ups", () => startWakeupJob({ log }), { log });

  // ---- The brief (V6 P1 S4.6, Product_V6 §14.4 item 7): one tick a minute so
  // a set time is noticed within a minute of arriving. The tick is a LOOKUP —
  // is a slot due, and did the world model move since the last brief? Nothing
  // changed means no call and no card; a set time that did move costs exactly
  // one brief.v2 call over a ledger code composed. Guarded inside the job.
  const briefJob = optionalStep("brief", () => startBriefJob({ log }), { log });

  // ---- Category backfill (P1.6, spec §5.1): chat streams get their Cat-1/2
  // by code (user-reply + the cached business tier split); browser streams
  // sync from the P0.8 per-domain verdicts. Zero model calls; every change
  // writes a decisions row.
  optionalStep("category backfill", () => {
    const chat = backfillChatCategories();
    const browser = backfillBrowserStreamCategories();
    if (chat.streams + browser.streams > 0) {
      console.error(
        `[worker] category backfill: chat ${chat.byCategory.cat1}/${chat.byCategory.cat2} ` +
          `(cat1/cat2), browser ${browser.byCategory.cat1}/${browser.byCategory.cat2}` +
          `${chat.changes.length + browser.changes.length > 0 ? `, changed=${chat.changes.length + browser.changes.length}` : ""}`,
      );
    }
  }, { log });

  // ---- Trace retention (P0.7): traces compress after 30 days (prompt/context
  // hashed + sampled full-keeps). One sweep shortly after boot, then daily.
  const traceRetention = optionalStep("trace retention", () => startTraceRetentionJob(), { log });

  // ---- Library maintenance (V6 P1 S6d L1): warm the Storage panel's measured
  // half once, off the request path, and truncate the WAL when the log has been
  // quiet for a while. Both exist because the Library's sub-tabs were measured
  // at 2-14 s on a real home with an import in flight.
  const libraryMaintenance = optionalStep("library maintenance", () => startLibraryMaintenance({ log }), { log });

  // ---- Dispatch (V6 P1 S3.3, Product_V6 §11.3 / §23.2): the state gate.
  // Every 5 s the dispatcher reads new event rows, gates the live ones (open
  // task · active episode · bridge/entity in an active space · addressed to
  // the twin → HOT; ≥4 content-new on one stream in 180 s → BURST; else the
  // cold window), flushes ONE live bundle when due on the pool's reserved live
  // lane, and fills the remaining slots with history days (newest first) and
  // tier-3 weekly digests. Slot cap, keyed in-flight and revalidate-at-
  // execution are invariants of the dispatcher itself. No new event, no call.
  const dispatcher = optionalStep("dispatcher", () => startDispatcher({ log }), { log });

  // ---- Consolidation + reduce (P1.4/P1.5, spec §6.3.2 / §15.2): every
  // minute — sweep newly-activated spaces, flag-triggered T2, drain the
  // Decide work queue; every hour — the rolling T2 (merge/split/dormancy,
  // second-look, unsorted review). Each duty is fenced inside the job.
  const consolidation = optionalStep("consolidation", () => startConsolidationJob({ log }), { log });

  // ---- The assist lane is GONE (R1, build §2.3 / §7.3 step 3). Its watcher
  // over the event-log tail — code trigger gate -> haiku evaluator ->
  // executor-lite -> artifact — is replaced by the live lane: the dispatcher
  // above bundles the same tail, ONE merged live.v1 call understands and
  // decides over it, and what it prepares reaches the user through
  // surfaces/router.ts. Nothing polls the tail on its own timer any more.

  // ---- Prepared-action queue (V6 P1 R2, Build §7.1 S4.2 / Product P1 §17):
  // the caller executor-lite was built without. Every two minutes, a LOOKUP —
  // is anything in `deferred_outputs` waiting? Empty means zero calls and no
  // log line. When something waits, at most two actions drain per tick, each
  // under executor-lite's own cycle and money ceilings. "Stop all model
  // activity" and the budget latch HOLD the queue instead of burning it (a run
  // resolves its row whatever the outcome). Guarded inside the job.
  const preparedQueue = optionalStep("prepared-action queue", () => startPreparedQueueJob({ log }), { log });

  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[worker] ${sig} received — shutting down`);
    try {
      // Kill any live children so nothing is orphaned...
      claudeLocalProvider.killAll();
      // Each handle is null when its subsystem never started (W1).
      parentWatch?.stop();
      dispatcher?.stop();
      consolidation?.stop();
      spendHeartbeat?.stop();
      traceRetention?.stop();
      libraryMaintenance?.stop();
      tiering?.stop();
      calendarJob?.stop();
      wakeups?.stop();
      briefJob?.stop();
      preparedQueue?.stop();
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
  // SUPERTWIN_WORKER_NO_PARENT=1 opts a deliberate headless run out. Optional
  // only in the sense that losing it must not take an already-serving worker
  // down; the crash-kill hook and the budget ceiling are the rails that hold.
  const parentWatch = optionalStep("parent watch", () => startParentWatch({
    onParentLost: (detail) => void shutdown(`parent lost (${detail})`),
  }), { log });

  // One line naming everything that came up short, so a degraded boot is
  // legible in worker.log without reading every line above it. /api/health
  // carries the same list for the app to read.
  const degraded = degradedSubsystems();
  if (degraded.length > 0) {
    console.error(`[worker] DEGRADED — the app is up without: ${degraded.join(", ")}`);
  }
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
