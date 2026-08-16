// Worker entrypoint.
//
// Boot sequence (docs/PHASE0_ARCHITECTURE.md §7, §9):
//   1. run DB migrations (idempotent).
//   2. register the claude-local provider (default) into the registry, and the
//      one source adapter into the ADAPTER registry — its manifest is validated
//      there, and an invalid manifest stops the boot (arch §2.2).
//   3. start the HTTP/SSE server, which prints exactly
//      `WORKER_READY port=<port>` to stdout so Tauri + tests detect readiness.
//   4. backfill stream tiers (§9.3 rule 4) — off the ready path, best-effort,
//      and re-run by ingest once the backfill has actually created streams.
//   5. start the bootstrap derivation driver (§9.1-§9.7) — the scheduled caller
//      for tier -> segment -> seal -> cohort -> episodes -> reconcile. It is
//      ON (`full`, capped) by default for an installed app; app_state
//      'bootstrap.mode' and SUPERTWIN_BOOTSTRAP override — cost note at the
//      call site.
//   6. on SIGINT/SIGTERM: stop the driver, close the server and kill any
//      in-flight `claude` children, then exit clean (kill-switch foundation —
//      no orphans).
//
// What actually boots (this comment used to say "there is no extraction engine,
// executor, scheduler or nightly runner", and that was accurate — the whole
// derivation layer existed but had ZERO production callers and was therefore
// absent from the esbuild bundle entirely):
//
//   - provider + chat (Phase 0) and WhatsApp ingestion (Phase 1);
//   - grounded chat retrieval — FTS over events at query time;
//   - four timers owned by the server: the media queue, the semantic indexer,
//     the nightly arc reconcile and the 15-minute episode clock;
//   - tiering, wired here and at the ingest seal;
//   - the bootstrap derivation driver, wired below — and with it the P-CL1
//     claims/loops stage, which this comment used to name as missing. It is
//     not: `scheduler/cl1-runner.ts` is the runner that was absent, and
//     `startBootstrapDriver` fills the driver's `deps.extract` seam with it, so
//     a bootstrap run now reaches claim_versions / claims_active / evidence.
//
// Still genuinely absent, and named here so the next reader does not have to
// re-derive it: there is no P-EP1 runner, so nothing writes graph EDGES;
// nothing writes `claim_embeddings`, so the [ML] near-hit rung stays blocked and
// P-AG3 is never bought; identity binding is unwired at ingest, so session
// participants are actor ids, not entity ids; and the steady driver's
// P-CL1Δ session runner (`SteadyDeps.extract`) is unfilled, so a due delta
// pass is refused loudly (`provider_outage`) rather than fired into a queue
// nothing drains — see `scheduler/steady.ts`.

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
import { ensureTiers } from "./tiers/ensure.js";
import { startBootstrapDriver, type BootstrapDriver } from "./scheduler/bootstrap.js";
import { startSteadyDriver, type SteadyDriver } from "./scheduler/steady.js";

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
    ingestion = new Ingestion(adapter, {
      manifest: registered.manifest,
      // The history-depth verdict and every extend outcome belong in the worker
      // log next to the daemon's own per-payload counters, so the NEXT real
      // re-link is diagnosable from one file instead of from a live session.
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

  const port = Number(process.env.SUPERTWIN_WORKER_PORT ?? 8011);
  const server: ServerHandle = await startServer({ port, ingestion });

  // ---- Tiers (item 1.2, arch §9.3 rule 4). Every stream gets a tier, and the
  // scheduler's primary sort key is that tier — a NULL one is a channel no lane
  // can reach. The prior build shipped `tier NULL` on all 97 channels because
  // `backfillTiers` had no caller at all; this is that caller.
  //
  // Deliberately AFTER startServer: tiering is never on the first-paint path
  // (§9.5.1) and must not delay `WORKER_READY`. It is also NOT sufficient on
  // its own — on a cold install boot happens before a single stream exists, so
  // this pass is vacuous and ingest re-runs `ensureTiers()` when the backfill
  // completes. `ensureTiers` never throws; a coverage failure is logged loudly
  // and the worker keeps serving.
  void ensureTiers({ reason: "boot" }).catch((err) => {
    console.error("[worker] tier backfill failed (continuing):", err);
  });

  // ---- The bootstrap derivation driver (item 1.8, arch §9.1-§9.7). This is
  // the caller `segment`, `sealStream`, `candidateSessions`, `sealCohort`,
  // `advanceCohort` and `reconcileAfterTransition` never had: all of them were
  // reachable only from tests and from the frozen-corpus harness in
  // `confluence/pipeline.ts`, which is why a live install ships zero sessions,
  // episodes and claims. The claims half arrives with it — the driver defaults
  // its `deps.extract` seam to `cl1ExtractStage()`, so no argument is needed
  // here and no other entry point can forget to pass one.
  //
  // COST: `resolveBootstrapMode()` is opts -> app_state('bootstrap.mode') ->
  // env(SUPERTWIN_BOOTSTRAP) -> **full**, and we deliberately pass no mode
  // here: an installed app DERIVES BY DEFAULT. The old silent-`off` default
  // meant a fresh install imported everything and derived nothing, for ever —
  // that was the bug, not the safeguard. `full` is still capped at 400 model
  // calls per tick, every call passes one shared `spend()` gate, the driver
  // logs the projection (calls + est dollars) before the first spend, the
  // resolved mode AND its source are logged at boot, and the ops lanes
  // (`POST /api/ops/lanes/pause`, lane `llm:understanding`) hold the spend
  // mid-run. Set app_state 'bootstrap.mode' or SUPERTWIN_BOOTSTRAP to `off`
  // to stop all spend — the free stages (watermark repair, tiers, identity,
  // rosters, arcs) run regardless of mode.
  //
  // Started here rather than beside the other four timers at
  // server/index.ts:351-356 only because that file is being edited
  // concurrently; `start`/`stop` are clean, so relocating it there is a move,
  // not a rewrite.
  let bootstrap: BootstrapDriver | null = null;
  try {
    bootstrap = startBootstrapDriver();
  } catch (err) {
    console.error("[worker] bootstrap driver failed to start (continuing):", err);
  }

  // ---- The steady-state driver (item 3.4, arch §8.1 exit + §8.3). Runs from
  // boot in BOTH modes: before the flip its tick is free work only — the
  // `enrich` lane-entry reconciliation and the settled check — and the flip
  // itself writes `app_state sources.mode = 'steady'` exactly once, when
  // `bootstrapSettled()` holds. COST: the live trigger's spend is bounded by
  // the shipped budgets in `scheduler/live-budgets.ts`, and while the P-CL1Δ
  // seam is unfilled a due delta pass is REFUSED loudly rather than committed.
  let steady: SteadyDriver | null = null;
  try {
    steady = startSteadyDriver();
  } catch (err) {
    console.error("[worker] steady driver failed to start (continuing):", err);
  }

  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[worker] ${sig} received — shutting down`);
    try {
      // Stop scheduling new work FIRST: `stop()` clears the interval and sets
      // the latch `runBootstrapTick` polls via `shouldStop`, so an in-flight
      // tick stops between stages instead of being killed mid-cohort.
      bootstrap?.stop();
      steady?.stop();
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
