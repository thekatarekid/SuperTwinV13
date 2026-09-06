#!/usr/bin/env node
// ===========================================================================
// fresh-install.mjs — the Stage 6 graduation flow (Build V6 P1 §9 item 2).
//
// One command that walks a FRESH install the way a new user does, and reports
// the two numbers §9 asks for:
//
//   consent card  →  30-day mock import  →  first proposed space
//
//   * elapsed to the first proposed space, against the "within 2 minutes" bar;
//   * the confirm card's cost projection against what the run actually spent
//     (±40%, the card's own accuracy label — consent/confirm-card.ts);
//   * the card's time projection against the measured import time (±30%).
//
// Also emits the week-one telemetry §9 item 3 wants recorded: the run's
// `cache_read_input_tokens` reality (V6 open question 6) and a calls/day
// projection from what this import actually spent.
//
// PROCESS RULES (build plan §1.3) honoured by construction:
//   1. SUPERTWIN_HOME is a throwaway scratch dir under os.tmpdir(); the
//      production home is refused outright.
//   2. The port is OS-assigned (or --port); 8013 is refused.
//   3. The worker is a CHILD with inherited stdio — never detached — reaped on
//      every exit path (success, failure, signal, timeout), and the port is
//      confirmed closed before the process exits.
//   4. WhatsApp runs as the Go daemon in --mock mode (SUPERTWIN_WHATSAPP_MOCK=1),
//      so nothing touches a real phone or a real account.
//
// This DOES spend money: the understanding lane makes real `claude` calls over
// the imported history. That is the point of the measurement. Set
// SUPERTWIN_BUDGET_USD_PER_DAY to lower the ceiling if you want a harder stop.
//
// Usage:
//   node scripts/fresh-install.mjs [--port N] [--understand 30d] [--timeout-ms N]
//                                  [--json FILE] [--keep-home]
// ===========================================================================

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect as netConnect } from "node:net";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(__dirname, "..");
export const PRODUCTION_PORT = 8013;
const KILL_GRACE_MS = 5_000;

/** The card's own accuracy labels (consent/confirm-card.ts) — the §9 bars. */
export const COST_TOLERANCE = 0.4;
export const TIME_TOLERANCE = 0.3;
/** Build §9 item 2: "first proposed space within 2 minutes". */
export const FIRST_SPACE_BUDGET_MS = 120_000;

// ---- Pure helpers (unit-tested by scripts/fresh-install.test.mjs) ----------

export function parseArgs(argv) {
  const opts = {
    port: null,
    understand: "30d",
    timeoutMs: 15 * 60 * 1000,
    json: null,
    keepHome: false,
    // Stop at the card. Product §3.4: "Nothing goes to a model before confirm",
    // so this walk of the funnel is FREE and provable — the runs ledger must
    // still be empty when it ends.
    stopBeforeConfirm: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === "--port") opts.port = Number(next());
    else if (a === "--understand") opts.understand = next();
    else if (a === "--timeout-ms") opts.timeoutMs = Number(next());
    else if (a === "--json") opts.json = next();
    else if (a === "--keep-home") opts.keepHome = true;
    else if (a === "--stop-before-confirm") opts.stopBeforeConfirm = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  if (opts.port !== null && (!Number.isInteger(opts.port) || opts.port <= 0)) {
    throw new Error(`--port ${opts.port} is not a port`);
  }
  if (opts.port === PRODUCTION_PORT) {
    throw new Error(
      `refusing port ${PRODUCTION_PORT}: that is the production worker (plan §1.3 rule 1)`,
    );
  }
  return opts;
}

/** ISO of the floor `range` implies, from `nowMs`. Only the ranges §9 needs. */
export function floorIso(range, nowMs) {
  const days = { "24h": 1, "3d": 3, "7d": 7, "30d": 30, "90d": 90, "180d": 180, "1y": 365 }[range];
  if (days === undefined) throw new Error(`unsupported understand range: ${range}`);
  return new Date(nowMs - days * 86_400_000).toISOString();
}

/**
 * Is `actual` inside `projected` ± `tolerance`? A projection of zero can only
 * be met by zero — a ratio against it is not a measurement.
 */
export function withinTolerance(projected, actual, tolerance) {
  if (!Number.isFinite(projected) || !Number.isFinite(actual)) return null;
  if (projected === 0) return actual === 0;
  return Math.abs(actual - projected) / projected <= tolerance;
}

/** Signed deviation actual-vs-projected as a fraction (0.12 = 12% over). */
export function deviation(projected, actual) {
  if (!Number.isFinite(projected) || !Number.isFinite(actual) || projected === 0) return null;
  return (actual - projected) / projected;
}

/**
 * The verdict lines. Separated from IO so the shape is testable without
 * booting anything.
 */
export function renderReport(m) {
  const pct = (v) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`);
  const verdictOf = (ok) => (ok === null ? "NO DATA" : ok ? "HOLDS" : "MISSES");
  const lines = [];
  lines.push("");
  lines.push("FRESH INSTALL — consent → 30-day mock import → first proposed space");
  lines.push(`  home            ${m.home}`);
  lines.push(`  port            ${m.port}`);
  lines.push(`  understand      ${m.understand} (floor ${m.understandFloor})`);
  lines.push("");
  lines.push("  flow");
  lines.push(`    pair                    ${m.pairMs} ms`);
  lines.push(`    counts                  ${m.countsMs} ms  (${m.countedEvents ?? "—"} events in window)`);
  lines.push(`    card                    ${m.cardMs} ms`);
  lines.push(`    confirm + import        ${m.importMs} ms  (${m.importedEvents} events landed)`);
  lines.push(`    understanding quiet     ${m.understandMs} ms  (confirm → the runs ledger stops growing)`);
  lines.push(`    episodes committed      ${m.episodes}`);
  lines.push(`    first proposed space    ${m.firstSpaceMs === null ? `NOT REACHED (${m.spaces} spaces)` : `${m.firstSpaceMs} ms`}`);
  lines.push(`    total (pair → space)    ${m.totalMs} ms`);
  lines.push("");
  lines.push("  card projection vs reality");
  lines.push(
    `    cost   projected $${m.projectedCostUsd?.toFixed(4) ?? "—"}   actual $${m.actualCostUsd.toFixed(4)}   ` +
      `dev ${pct(m.costDeviation)}   ±40% ${verdictOf(m.costWithin)}`,
  );
  lines.push(
    `    time   projected ${m.projectedTimeSec?.toFixed(1) ?? "—"} s   actual ${(m.understandMs / 1000).toFixed(1)} s   ` +
      `dev ${pct(m.timeDeviation)}   ±30% ${verdictOf(m.timeWithin)}`,
  );
  lines.push(
    `    first space within 2 min        ${
      m.firstSpaceMs === null ? "NO DATA" : m.firstSpaceMs <= FIRST_SPACE_BUDGET_MS ? "HOLDS" : "MISSES"
    }`,
  );
  lines.push("");
  lines.push("  week-one telemetry");
  lines.push(`    model calls this import         ${m.modelCalls}`);
  lines.push(`    cost per understood day         $${m.costPerUnderstandDay?.toFixed(5) ?? "—"}`);
  lines.push(
    `    cache_read_input_tokens         ${m.cacheReadTokens} of ${m.totalInputTokens} input ` +
      `(hit rate ${m.cacheHitRate === null ? "—" : `${(m.cacheHitRate * 100).toFixed(1)}%`})`,
  );
  lines.push(`    calls/day projection            ${m.callsPerDayProjection ?? "—"}`);
  lines.push("");
  lines.push("  runs by pass and outcome (a `retried` is a repair round; a `quarantined` is spend with nothing to show)");
  for (const r of m.runsByPass ?? []) lines.push(`    ${String(r.pass).padEnd(14)} ${String(r.status).padEnd(12)} ${r.n}`);
  lines.push("");
  lines.push(
    `  CORPUS CAVEAT: the mock fixture holds ${m.importedEvents} events over the window. ` +
      `The card's $/day and s/day constants model a REAL user's density, so the`,
  );
  lines.push(
    "  ±40%/±30% bands are only a fair test of the card on a real 30-day corpus (the clean-macOS-account human step).",
  );
  lines.push("");
  return lines.join("\n");
}

// ---- IO ---------------------------------------------------------------------

async function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => res(port));
    });
  });
}

function portClosed(port) {
  return new Promise((res) => {
    const sock = netConnect({ port, host: "127.0.0.1" });
    const done = (closed) => {
      sock.destroy();
      res(closed);
    };
    sock.once("connect", () => done(false));
    sock.once("error", () => done(true));
    setTimeout(() => done(true), 1_000);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(port, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON — the caller sees the status and the raw text */
  }
  return { status: res.status, json, text };
}

/**
 * COUNT(*) over one table of the worker's live DB, read-only. Returns -1 when
 * the file is not there yet or the table does not exist — a missing row set is
 * "not yet", never a crash.
 */
function counts_(dbPath, table) {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    } finally {
      db.close();
    }
  } catch {
    return -1;
  }
}

/** Per-pass run outcomes — how much of the spend was repair rounds. */
function passCounts_(dbPath) {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      return db.prepare(`SELECT pass, status, COUNT(*) AS n FROM runs GROUP BY pass, status`).all();
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

async function waitFor(fn, timeoutMs, label, intervalMs = 500) {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(intervalMs);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // --- Rail 1: a scratch home, never the production one ---------------------
  const productionHome = join(homedir(), "SuperTwinV13");
  const home = mkdtempSync(join(tmpdir(), "supertwin-fresh-install-"));
  if (resolve(home) === resolve(productionHome)) {
    throw new Error("refusing to run against the production home");
  }

  // --- Rail 2: never 8013 ---------------------------------------------------
  const port = opts.port ?? (await freePort());
  if (port === PRODUCTION_PORT) throw new Error(`refusing port ${PRODUCTION_PORT}`);

  console.error(`fresh-install: home=${home} port=${port} understand=${opts.understand}`);

  const dbPath = join(home, "supertwin.db");
  const env = {
    ...process.env,
    SUPERTWIN_HOME: home,
    SUPERTWIN_WORKER_PORT: String(port),
    SUPERTWIN_WHATSAPP_MOCK: "1",
    // The DB path must follow the scratch home, not a stale export.
    SUPERTWIN_DB_PATH: dbPath,
  };
  delete env.SUPERTWIN_LAUNCHED_BY;
  delete env.SUPERTWIN_ALLOW_PRODUCTION_HOME;

  const tsx = join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsx, join(REPO, "worker", "src", "index.ts")], {
    cwd: REPO,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  });

  let reaped = false;
  const reap = async () => {
    if (reaped) return;
    reaped = true;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const deadline = Date.now() + KILL_GRACE_MS;
      while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
        await sleep(100);
      }
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    // The port must be closed before this process ends (plan §1.3 rule 3).
    for (let i = 0; i < 40 && !(await portClosed(port)); i += 1) await sleep(250);
    const closed = await portClosed(port);
    console.error(`fresh-install: worker reaped; port ${port} closed=${closed}`);
    if (!opts.keepHome) {
      rmSync(home, { recursive: true, force: true });
      console.error(`fresh-install: scratch home removed`);
    }
  };
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      reap().then(() => process.exit(130));
    });
  }

  try {
    await waitFor(
      async () => {
        try {
          const r = await api(port, "GET", "/api/health");
          return r.status === 200;
        } catch {
          return false;
        }
      },
      90_000,
      "worker health",
    );

    const t0 = Date.now();

    // 1. Pair (mock daemon — no phone, no account).
    const pair = await api(port, "POST", "/api/sources/whatsapp/pair", {});
    if (pair.status >= 400) throw new Error(`pair failed: ${pair.status} ${pair.text}`);
    await waitFor(
      async () => {
        const s = await api(port, "GET", "/api/sources/whatsapp/status");
        return s.json?.paired === true;
      },
      60_000,
      "mock pairing",
    );
    const tPaired = Date.now();

    // 2. Count what exists (real counts, never a guess — Product §3.3).
    const counts = await api(port, "GET", "/api/sources/whatsapp/counts");
    const tCounted = Date.now();
    // `counts` is the RangeCounts envelope: counts.counts["30d"].messages.
    const countedEvents = counts.json?.counts?.counts?.[opts.understand]?.messages ?? null;

    // 3. The confirm card — the projection §9 measures against.
    const understandFloor = floorIso(opts.understand, Date.now());
    const card = await api(port, "POST", "/api/consent/card", {
      source: "whatsapp",
      index_all: true,
      understand_from: understandFloor,
      counts: countedEvents === null ? undefined : { index: null, understand: countedEvents, exact: true },
    });
    if (card.status >= 400) throw new Error(`card failed: ${card.status} ${card.text}`);
    const tCard = Date.now();
    const cardBody = card.json?.card ?? card.json;
    const projectedCostUsd = cardBody?.cost?.value ?? null;
    const projectedTimeSec = cardBody?.time?.value ?? null;
    const cardText = cardBody?.text ?? "";

    if (opts.stopBeforeConfirm) {
      const pre = await api(port, "GET", "/api/usage?window=today");
      const preRuns = Number(pre.json?.runs?.total ?? 0);
      console.log("");
      console.log("FRESH INSTALL — funnel to the card only (nothing confirmed)");
      console.log(`  counted events in ${opts.understand}   ${countedEvents}`);
      console.log(`  card cost projection          $${projectedCostUsd}`);
      console.log(`  card time projection          ${projectedTimeSec} s`);
      console.log(`  model calls before confirm    ${preRuns}  (must be 0 — Product §3.4)`);
      console.log("");
      if (preRuns !== 0) process.exitCode = 1;
      return;
    }

    // 4. Confirm — grants consent AND drains the buffered history.
    const confirm = await api(port, "POST", "/api/sources/whatsapp/confirm", {
      index: "all",
      understand: opts.understand,
      card_text: cardText,
    });
    if (confirm.status >= 400) throw new Error(`confirm failed: ${confirm.status} ${confirm.text}`);

    // 5. The import lands events; then the understanding lane runs over them.
    //    Read the worker's own DB rather than a route: the routes shape their
    //    answers for the UI, and what we are timing is what the pipeline WROTE.
    //    "Landed" = events stopped arriving for IMPORT_QUIET_MS.
    const IMPORT_QUIET_MS = 5_000;
    let lastCount = -1;
    let lastChange = Date.now();
    await waitFor(
      async () => {
        const n = counts_(dbPath, "events");
        if (n !== lastCount) {
          lastCount = n;
          lastChange = Date.now();
        }
        return n > 0 && Date.now() - lastChange >= IMPORT_QUIET_MS;
      },
      opts.timeoutMs,
      "the mock import to land events",
    );
    const tImported = Date.now();
    const importedEvents = lastCount;

    // The card's TIME line is understand-days x 8.2 s SERIAL — the time to
    // UNDERSTAND the window, not the time to land its events. So the honest
    // actual is confirm -> the runs ledger going quiet, which is what the
    // ±30% band is compared against below.
    const UNDERSTAND_QUIET_MS = 30_000;
    let lastRuns = -1;
    let lastRunChange = Date.now();
    try {
      await waitFor(
        () => {
          const n = counts_(dbPath, "runs");
          if (n !== lastRuns) {
            lastRuns = n;
            lastRunChange = Date.now();
          }
          return n > 0 && Date.now() - lastRunChange >= UNDERSTAND_QUIET_MS;
        },
        opts.timeoutMs,
        "the understanding lane to go quiet",
        1_000,
      );
    } catch (err) {
      console.error(`fresh-install: ${(err && err.message) || err}`);
    }
    const understandMs = Date.now() - tCard - UNDERSTAND_QUIET_MS;

    // 6. The first proposed space. The understanding lane runs after the
    //    import: episodes commit, and a space is proposed when one carries
    //    goal evidence. Zero spaces after the whole window is a RESULT, not a
    //    harness failure — the report says so.
    let firstSpaceMs = null;
    let spaceCount = 0;
    try {
      await waitFor(
        async () => {
          spaceCount = counts_(dbPath, "spaces");
          return spaceCount > 0;
        },
        opts.timeoutMs,
        "the first proposed space",
        1_000,
      );
      firstSpaceMs = Date.now() - tImported;
    } catch (err) {
      console.error(`fresh-install: ${(err && err.message) || err}`);
    }
    const episodes = counts_(dbPath, "episodes");
    const quarantined = passCounts_(dbPath);

    // 7. What it actually cost.
    const usage = await api(port, "GET", "/api/usage?window=today");
    const totals = usage.json?.totals ?? {};
    const actualCostUsd = Number(totals.costUsd ?? totals.cost_usd ?? 0);
    const modelCalls = Number(usage.json?.runs?.total ?? totals.runs ?? 0);
    const cacheReadTokens = Number(totals.cacheReadTokens ?? totals.cache_read ?? 0);
    const totalInputTokens = Number(totals.totalInputTokens ?? totals.input_tokens ?? 0);
    const cacheHitRate = usage.json?.cache?.hitRate ?? null;

    const understandDays = Math.round(
      (Date.now() - Date.parse(understandFloor)) / 86_400_000,
    );
    const importMs = tImported - tCard;
    const metrics = {
      home,
      port,
      understand: opts.understand,
      understandFloor,
      pairMs: tPaired - t0,
      countsMs: tCounted - tPaired,
      cardMs: tCard - tCounted,
      importMs,
      understandMs,
      firstSpaceMs,
      totalMs: Date.now() - t0,
      countedEvents,
      importedEvents,
      episodes,
      spaces: spaceCount,
      runsByPass: quarantined,
      projectedCostUsd,
      projectedTimeSec,
      actualCostUsd,
      modelCalls,
      cacheReadTokens,
      totalInputTokens,
      cacheHitRate,
      costDeviation: deviation(projectedCostUsd, actualCostUsd),
      timeDeviation: deviation(projectedTimeSec, understandMs / 1000),
      costWithin: withinTolerance(projectedCostUsd, actualCostUsd, COST_TOLERANCE),
      timeWithin: withinTolerance(projectedTimeSec, understandMs / 1000, TIME_TOLERANCE),
      costPerUnderstandDay: understandDays > 0 ? actualCostUsd / understandDays : null,
      callsPerDayProjection: understandDays > 0 ? Math.round((modelCalls / understandDays) * 10) / 10 : null,
    };

    console.log(renderReport(metrics));
    if (opts.json) {
      writeFileSync(opts.json, `${JSON.stringify(metrics, null, 2)}\n`);
      console.error(`fresh-install: metrics written to ${opts.json}`);
    }
  } finally {
    await reap();
  }
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`fresh-install: ${(err && err.stack) || err}`);
    process.exitCode = 1;
  });
}
