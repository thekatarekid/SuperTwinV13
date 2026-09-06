#!/usr/bin/env node
// ===========================================================================
// e2e-understand.mjs — from nothing to understanding, on a scratch home.
//
// The 13.11.5 field failure was not "a surface renders wrong": every surface
// was empty because the pipeline never produced anything for them to render.
// Unit tests could not have caught it — each half was green. So this drives
// the WHOLE thing, once, for real:
//
//   seed a realistic corpus (worker/src/evals/seed-corpus.ts)
//     -> boot the real worker entrypoint on a scratch home and a free port
//     -> let the live / history / digest lanes run against the real `claude`
//     -> assert, with real queries, that events dispatched, runs and traces
//        were written, episodes and spaces exist, tasks and people populated,
//        and that the exact surfaces the user found empty return rows.
//
// This one SPENDS MONEY (plan §1.3 rule 5). It is bounded three ways: the
// Understand window covers a 3-day slice of an 8-month corpus, the budget
// ceiling is lowered to --max-calls for the run, and the driver stops at
// --minutes. Expect ~25-45 calls; the ceiling refuses the 61st.
//
// Plan §1.3 honoured by construction: SUPERTWIN_HOME is a temp dir, the port
// is OS-assigned (never 8013), the worker is a CHILD (never detached) and is
// reaped on every exit path, and the port is confirmed closed before exit.
//
// Usage:
//   node scripts/e2e-understand.mjs [--minutes 8] [--max-calls 60]
//                                   [--home <dir>] [--keep] [--scale 1]
//
// --home reuses an existing scratch home (a second round continues where the
// first stopped); without it a fresh one is minted and (unless --keep) removed.
// ===========================================================================

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const WORKER_DIR = join(REPO, "worker");
const TSX = join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
const PRODUCTION_PORT = 8013;

// ---- args -----------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(`--${name}`);

const MINUTES = Number(flag("minutes", 8));
const MAX_CALLS = Number(flag("max-calls", 60));
const SCALE = flag("scale", "1");
const KEEP = has("keep");
const REUSE_HOME = flag("home", null);
/**
 * Zero-call pre-flight: throw the kill switch before boot, so the whole
 * process runs with the lanes HELD. It proves two things for free — the
 * worker boots and serves every surface on a scratch home, and FIX-C1's hold
 * really does stand the lanes down in a real process (no calls, no stamps, no
 * dead letters, the backlog intact) instead of burning the backlog.
 */
const PAUSED = has("paused");

// ---- reporting ------------------------------------------------------------
const results = [];
let failures = 0;
function check(name, cond, detail = "") {
  const ok = Boolean(cond);
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

// ---- process bookkeeping --------------------------------------------------
let worker = null;
let home = null;
let port = 0;

function reap() {
  if (worker && worker.pid && !worker.killed) {
    try { process.kill(worker.pid, "SIGTERM"); } catch { /* gone */ }
    const until = Date.now() + 6000;
    while (Date.now() < until) {
      try { process.kill(worker.pid, 0); } catch { break; }
      spawnSync("sleep", ["0.2"]);
    }
    try { process.kill(worker.pid, "SIGKILL"); } catch { /* gone */ }
  }
  worker = null;
}
process.on("exit", reap);
process.on("SIGINT", () => { reap(); process.exit(130); });
process.on("SIGTERM", () => { reap(); process.exit(143); });

function portOpen(p) {
  try {
    const out = execFileSync("lsof", ["-nP", `-i:${p}`], { encoding: "utf8" });
    return out.trim().length > 0;
  } catch {
    return false; // lsof exits 1 when nothing is listening
  }
}

async function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => res(p));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  const t0 = Date.now();
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(30_000) });
    const body = await r.text();
    let json = null;
    try { json = JSON.parse(body); } catch { /* not json */ }
    return { status: r.status, json, body, ms: Date.now() - t0 };
  } catch (err) {
    return { status: 0, json: null, body: String(err), ms: Date.now() - t0 };
  }
}

// ---- read-only DB view ----------------------------------------------------
function ro(dbPath) {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}
function one(db, sql, ...args) {
  try { return db.prepare(sql).get(...args); } catch (err) { return { error: String(err) }; }
}
function all(db, sql, ...args) {
  try { return db.prepare(sql).all(...args); } catch { return []; }
}

// ---------------------------------------------------------------------------

async function main() {
  console.log("[e2e-understand] plan §1.3: scratch home, OS-assigned port, child process, reaped.\n");

  home = REUSE_HOME ?? mkdtempSync(join(tmpdir(), "supertwin-e2e-understand-"));
  mkdirSync(home, { recursive: true });
  const dbPath = join(home, "supertwinv13.db");
  port = await freePort();
  if (port === PRODUCTION_PORT) throw new Error("refusing the production port");
  console.log(`  home ${home}\n  port ${port}\n`);

  // ---- 1. seed ------------------------------------------------------------
  if (!REUSE_HOME) {
    console.log("[1/5] seeding the corpus (zero model calls)…");
    const seed = spawnSync(process.execPath, [TSX, "src/evals/seed-corpus.ts", "--scale", String(SCALE)], {
      cwd: WORKER_DIR,
      env: { ...process.env, SUPERTWIN_HOME: home, SUPERTWIN_DB_PATH: dbPath },
      encoding: "utf8",
    });
    if (seed.status !== 0) {
      console.error(seed.stdout, seed.stderr);
      throw new Error(`seed failed (${seed.status})`);
    }
    const report = JSON.parse(seed.stdout.slice(seed.stdout.indexOf("{")));
    console.log(`  ${report.inserted} rows inserted (${report.waEvents} wa envelopes, ${report.browserEvents} browser)`);
    console.log(`  index_from ${report.indexFrom}  understand_from ${report.understandFrom}\n`);

    const db = ro(dbPath);
    const byOrigin = all(db, `SELECT origin, COUNT(*) n FROM events GROUP BY origin`);
    const pending = one(db, `SELECT COUNT(*) n FROM events WHERE dispatched_at IS NULL`);
    console.log(`  origins: ${byOrigin.map((r) => `${r.origin}=${r.n}`).join(" ")}`);
    console.log(`  awaiting dispatch (dispatched_at IS NULL): ${pending.n}\n`);
    check("seed: the archive majority is stamped and invisible to every lane",
      (byOrigin.find((r) => r.origin === "archive")?.n ?? 0) > 1000,
      `${byOrigin.find((r) => r.origin === "archive")?.n ?? 0} archive rows`);
    check("seed: the Understand slice is UNSTAMPED and offerable", pending.n > 20 && pending.n < 400, `${pending.n} rows`);
    db.close();
  }

  let heldBaseline = null;
  if (PAUSED) {
    const w = new Database(dbPath);
    w.prepare(`INSERT INTO app_state (key, value) VALUES ('model_activity_paused', ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(new Date().toISOString());
    heldBaseline = {
      pending: w.prepare(`SELECT COUNT(*) n FROM events WHERE dispatched_at IS NULL`).get().n,
      runs: w.prepare(`SELECT COUNT(*) n FROM runs`).get().n,
    };
    w.close();
    console.log(`  [--paused] kill switch thrown before boot; ${heldBaseline.pending} rows must survive it.\n`);
  }

  // ---- 2. boot ------------------------------------------------------------
  console.log("[2/5] booting the real worker entrypoint…");
  const env = { ...process.env };
  delete env.SUPERTWIN_LAUNCHED_BY;
  delete env.SUPERTWIN_ALLOW_PRODUCTION_HOME;
  env.SUPERTWIN_HOME = home;
  env.SUPERTWIN_DB_PATH = dbPath;
  env.SUPERTWIN_WORKER_PORT = String(port);
  env.SUPERTWIN_WORKER_NO_PARENT = "1";
  // The spend rail for this run: the 61st call is refused before spawn.
  env.SUPERTWIN_BUDGET_CALLS_PER_HOUR = String(MAX_CALLS);
  env.SUPERTWIN_BUDGET_CALLS_PER_DAY = String(MAX_CALLS);

  const logPath = join(home, "e2e-worker.log");
  let log = "";
  worker = spawn(process.execPath, [TSX, "src/index.ts"], {
    cwd: WORKER_DIR, env, stdio: ["ignore", "pipe", "pipe"], detached: false,
  });
  const onData = (c) => {
    const s = c.toString("utf8");
    log += s;
    if (log.length > 4_000_000) log = log.slice(-2_000_000);
  };
  worker.stdout.on("data", onData);
  worker.stderr.on("data", onData);

  const readyBy = Date.now() + 120_000;
  let ready = false;
  while (Date.now() < readyBy) {
    const h = await get("/api/health");
    if (h.status === 200) { ready = true; break; }
    if (worker.exitCode !== null) break;
    await sleep(1000);
  }
  if (!ready) {
    writeFileSync(logPath, log);
    console.error(log.slice(-6000));
    throw new Error("worker never became healthy");
  }
  console.log(`  healthy on 127.0.0.1:${port}\n`);

  // ---- 3. let it run ------------------------------------------------------
  const runMinutes = PAUSED ? Math.min(MINUTES, 1.5) : MINUTES;
  console.log(`[3/5] running the pipeline for up to ${runMinutes} min (ceiling ${MAX_CALLS} calls)…`);
  const deadline = Date.now() + runMinutes * 60_000;
  let last = "";
  while (Date.now() < deadline) {
    await sleep(10_000);
    const db = ro(dbPath);
    const s = {
      runs: one(db, `SELECT COUNT(*) n FROM runs`).n,
      ok: one(db, `SELECT COUNT(*) n FROM runs WHERE status IN ('ok','committed','succeeded')`).n,
      ep: one(db, `SELECT COUNT(*) n FROM episodes`).n,
      sp: one(db, `SELECT COUNT(*) n FROM spaces`).n,
      tk: one(db, `SELECT COUNT(*) n FROM tasks`).n,
      pend: one(db, `SELECT COUNT(*) n FROM events WHERE dispatched_at IS NULL`).n,
      // Tier-3 streams are the WEEKLY digest lane's, never history's
      // (history.ts pendingHistoryDays skips tier >= 3), so their rows sit
      // undispatched between digests by design. Only the tier 1-2 backlog is
      // what "drained" can mean.
      pend12: one(db, `SELECT COUNT(*) n FROM events e LEFT JOIN streams s ON s.id = e.stream_id
                        WHERE e.dispatched_at IS NULL AND COALESCE(s.tier,'T1') NOT IN ('T3','T4')`).n,
      cost: (one(db, `SELECT ROUND(SUM(cost_usd),3) c FROM runs`).c ?? 0),
    };
    db.close();
    const line = `  runs=${s.runs} (ok ${s.ok}) episodes=${s.ep} spaces=${s.sp} tasks=${s.tk} ` +
      `pending=${s.pend} (T1-2 ${s.pend12}) $${s.cost}`;
    if (line !== last) { console.log(line); last = line; }
    // Done when the backlog is drained AND something was understood.
    if (!PAUSED && s.pend12 === 0 && s.ep > 0 && s.sp > 0) {
      console.log(`  understanding backlog drained (${s.pend} tier-3 rows wait for the weekly digest).\n`);
      break;
    }
    if (worker.exitCode !== null) { console.log("  worker exited early.\n"); break; }
  }

  // ---- 4. assert ----------------------------------------------------------
  console.log("\n[4/5] asserting the pipeline produced understanding");
  const db = ro(dbPath);

  const runs = one(db, `SELECT COUNT(*) n FROM runs`).n;
  const okRuns = one(db, `SELECT COUNT(*) n FROM runs WHERE error_code IS NULL`).n;
  const calls = one(db, `SELECT COUNT(*) n FROM runs WHERE model IS NOT NULL`).n;
  const cost = one(db, `SELECT ROUND(COALESCE(SUM(cost_usd),0),4) c FROM runs`).c;
  const tok = one(db, `SELECT COALESCE(SUM(billable_tokens),0) t FROM runs`).t;
  const dispatched = one(db, `SELECT COUNT(*) n FROM events WHERE dispatched_at IS NOT NULL AND origin <> 'archive'`).n;
  const stillPending = one(db, `SELECT COUNT(*) n FROM events WHERE dispatched_at IS NULL`).n;
  const stillPending12 = one(db, `SELECT COUNT(*) n FROM events e LEFT JOIN streams s ON s.id = e.stream_id
                                   WHERE e.dispatched_at IS NULL AND COALESCE(s.tier,'T1') NOT IN ('T3','T4')`).n;
  const traces = one(db, `SELECT COUNT(*) n FROM traces`).n;
  const episodes = one(db, `SELECT COUNT(*) n FROM episodes`).n;
  const spaces = all(db, `SELECT id, label, status FROM spaces`);
  const tasks = all(db, `SELECT id, title, status, due FROM tasks`);
  const people = one(db, `SELECT COUNT(*) n FROM entities WHERE type = 'person'`).n;
  const claims = one(db, `SELECT COUNT(*) n FROM claims`).n;
  const decisions = one(db, `SELECT COUNT(*) n FROM decisions`).n;
  const scheduled = one(db, `SELECT COUNT(*) n FROM tasks WHERE status = 'scheduled'`).n;
  const calEvents = one(db, `SELECT COUNT(*) n FROM calendar_events`).n;
  const bridges = one(db, `SELECT COUNT(*) n FROM bridges`).n;
  const tripped = one(db, `SELECT value FROM app_state WHERE key = 'budget_tripped_at'`);
  const quarantined = one(db, `SELECT COUNT(*) n FROM quarantine`).n;
  const errs = all(db, `SELECT error_code, COUNT(*) n FROM runs WHERE error_code IS NOT NULL GROUP BY error_code ORDER BY n DESC LIMIT 6`);

  console.log(`\n  ledger: ${runs} runs, ${okRuns} without an error, ${calls} with a model, ${tok} tok, $${cost}`);
  if (errs.length) console.log(`  errors: ${errs.map((e) => `${e.error_code}×${e.n}`).join(" ")}`);
  console.log(`  spaces: ${spaces.map((s) => `${s.label} [${s.status}]`).join(" | ") || "(none)"}`);
  console.log(`  tasks:  ${tasks.slice(0, 8).map((t) => `${t.title} [${t.status}${t.due ? ` due ${t.due}` : ""}]`).join(" | ") || "(none)"}\n`);

  if (PAUSED) {
    const attempts = one(db, `SELECT COUNT(*) n FROM bundle_attempts`).n;
    check("HOLD: zero model calls while the kill switch is on", calls === 0, `${calls} calls`);
    check("HOLD: the backlog is INTACT — nothing stamped, nothing eaten", stillPending === heldBaseline.pending,
      `${stillPending} of ${heldBaseline.pending} rows still awaiting dispatch`);
    check("HOLD: no bundle_attempts row (a hold is not a failure)", attempts === 0, `${attempts} attempts`);
    check("HOLD: nothing quarantined / dead-lettered", quarantined === 0, `${quarantined} quarantined`);
    check("HOLD: it says so — [budget] HELD in the log", /\[budget\] HELD/.test(log), "");
  } else {
    check("PIPELINE dispatched: events left dispatched_at IS NULL for a model", dispatched > 0, `${dispatched} events stamped by a lane`);
    check("PIPELINE ran: the run ledger has model calls", calls > 0, `${calls} calls, $${cost}`);
    check("PIPELINE traced: traces were written", traces > 0, `${traces} traces`);
    check("UNDERSTANDING: episodes exist", episodes > 0, `${episodes} episodes`);
    check("UNDERSTANDING: at least one space exists", spaces.length > 0, `${spaces.length} spaces`);
    check("UNDERSTANDING: tasks were extracted", tasks.length > 0, `${tasks.length} tasks`);
    check("UNDERSTANDING: people were resolved", people > 0, `${people} person entities`);
    check("MEMORY: claims were written (the extract pass)", claims > 0, `${claims} claims`);
    if (claims === 0) {
      const extractRuns = one(db, `SELECT COUNT(*) n FROM runs WHERE kind LIKE 'extract%'`).n;
      console.log(`        extract runs in the ledger: ${extractRuns}. brain/reduce.runReduce — the only`);
      console.log(`        function that calls runExtractPass — has no production caller;`);
      console.log(`        consolidation/job.ts drains decide_queue and nothing drains extract.`);
    }
    check("AUDIT: decisions were logged", decisions > 0, `${decisions} decisions`);
    check("RAIL: the budget latch did NOT trip", !tripped || !tripped.value, tripped?.value ? `tripped at ${tripped.value}` : "clean");
    check("RAIL: nothing was quarantined", quarantined === 0, `${quarantined} quarantined`);
    check("SPEND: under the stated ceiling", calls <= MAX_CALLS, `${calls} ≤ ${MAX_CALLS}`);
    check("BACKLOG: the tier 1-2 understanding backlog is drained", stillPending12 === 0,
      `${stillPending12} tier 1-2 rows left; ${stillPending - stillPending12} tier-3 rows wait for the weekly digest`);
  }
  console.log(`  scheduled_tasks=${scheduled} calendar_events=${calEvents} bridges=${bridges} claims=${claims} people=${people}`);

  db.close();

  // ---- 5. the surfaces the user found empty -------------------------------
  console.log("\n[5/5] the surfaces (the exact ones reported empty)");
  const n = (v) => (Array.isArray(v) ? v.length : 0);
  // [name, path, keys the shape must carry, how many rows the tab renders]
  const surfaces = [
    ["Home",          "/api/home",                     ["today", "spaces", "review"], (j) => n(j?.today) + n(j?.spaces) + n(j?.review) + n(j?.recent_understanding)],
    ["Spaces",        "/api/spaces/list",              ["areas", "dormant"],          (j) => n(j?.areas) + n(j?.dormant) + (j?.proposed_count ?? 0)],
    ["Timeline",      "/api/timeline?limit=50",        ["rows"],                      (j) => n(j?.rows)],
    ["Timeline/days", "/api/timeline/days",            ["days"],                      (j) => n(j?.days)],
    ["Calendar",      "/api/calendar?tz=Asia/Kolkata", ["items", "layers"],           (j) => n(j?.items)],
    ["People",        "/api/people",                   ["people"],                    (j) => n(j?.people)],
    ["Library",       "/api/library/chats?limit=20",   ["streams"],                   (j) => n(j?.streams)],
    ["Tasks",         "/api/tasks",                    ["sections"],                  (j) => j?.total ?? 0],
    ["People/who-i-am", "/api/people/who-i-am",        [],                            () => 1],
    ["People/radar",  "/api/people/radar",             ["radar"],                     () => 1],
    ["Settings",      "/api/settings/general",         [],                            () => 1],
  ];
  for (const [name, path, keys, rows] of surfaces) {
    const r = await get(path);
    const shaped = r.status === 200 && r.json !== null && keys.every((k) => k in r.json);
    const count = shaped ? rows(r.json) : 0;
    // Under --paused nothing has been understood yet, so only the shape is
    // asserted. In the real run these are the tabs the user found empty.
    const good = shaped && (PAUSED || count > 0);
    check(`SURFACE ${name} (${path})`, good, `HTTP ${r.status} · ${count} rows · ${r.body.length}B · ${r.ms}ms`);
    if (!shaped && r.json) console.log(`        body keys: ${Object.keys(r.json).join(", ")}`);
  }

  // Every main tab, timed — the "switching tabs is very slow" report.
  console.log("\n  main-tab latency (cold, sequential):");
  for (const [name, path] of [["Home", "/api/home"], ["Spaces", "/api/spaces/list"], ["Calendar", "/api/calendar?tz=Asia/Kolkata"],
                              ["Timeline", "/api/timeline/days"], ["Library", "/api/library/storage"], ["People", "/api/people"],
                              ["Settings", "/api/settings/general"]]) {
    const r = await get(path);
    console.log(`    ${name.padEnd(9)} ${String(r.ms).padStart(6)}ms  HTTP ${r.status}`);
  }

  writeFileSync(logPath, log);
  console.log(`\n  worker log: ${logPath}`);
  const spend = /\[spend\][^\n]*/g;
  const spendLines = log.match(spend) ?? [];
  console.log(`  last heartbeat: ${spendLines[spendLines.length - 1] ?? "(none)"}`);
  const held = (log.match(/\[budget\] HELD/g) ?? []).length;
  console.log(`  [budget] HELD lines: ${held}`);

  return { calls, cost };
}

let summary = { calls: 0, cost: 0 };
try {
  summary = await main();
} catch (err) {
  console.error(`\n[e2e-understand] FATAL: ${err?.stack ?? err}`);
  failures += 1;
} finally {
  reap();
  await sleep(700);
  const open = portOpen(port);
  console.log(`\n[teardown] worker reaped; port ${port} ${open ? "STILL OPEN" : "closed"}.`);
  if (open) failures += 1;
  if (home && !KEEP && !REUSE_HOME) {
    rmSync(home, { recursive: true, force: true });
    console.log(`[teardown] scratch home removed.`);
  } else if (home) {
    console.log(`[teardown] scratch home kept at ${home}`);
  }
}

console.log(`\n[e2e-understand] ${results.filter((r) => r.ok).length}/${results.length} checks passed · ` +
            `${summary.calls} live model calls · $${summary.cost}`);
if (failures > 0) {
  console.log(`[e2e-understand] FAILURES:`);
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}${r.detail ? ` (${r.detail})` : ""}`);
}
process.exit(failures > 0 ? 1 : 0);
