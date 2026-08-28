#!/usr/bin/env node
// ===========================================================================
// Privacy audit (build plan §8, release checklist): scan a day's event log
// for content that must NEVER be captured — private/incognito browsing and
// password-manager windows. The capture layers veto these at the source
// (screenwatch privacy veto + worker nodePrivacyVeto + browser watcher); this
// script is the independent after-the-fact check that the vetoes held.
//
//   node scripts/privacy-audit.mjs                 # today, default home DB
//   node scripts/privacy-audit.mjs --day 2026-08-28
//   node scripts/privacy-audit.mjs --db /path/to/supertwinv13.db --all-days
//
// Exit codes: 0 clean · 1 findings · 2 could not open the DB.
// ===========================================================================

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "..", "worker", "package.json"));
const Database = require("better-sqlite3");

// Mirrors worker/src/adapters/screen/adapter.ts (the capture-side veto).
const PASSWORD_MANAGER_MARKERS = [
  "com.1password.",
  "com.agilebits.onepassword",
  "com.apple.passwords",
  "com.bitwarden.",
  "com.dashlane.",
  "com.lastpass.",
  "com.roboform.",
  "com.keepersecurity.",
  "com.protonmail.pass",
  "1password",
  "bitwarden",
  "lastpass",
  "dashlane",
  "keeper password",
  "roboform",
  "proton pass",
];
const PRIVATE_MARKERS = ["private browsing", "(incognito)", "incognito)", "(private)"];

function parseArgs(argv) {
  const opts = {
    db: process.env.SUPERTWIN_DB_PATH ?? join(process.env.SUPERTWIN_HOME ?? join(homedir(), "SuperTwinV13"), "supertwinv13.db"),
    day: new Date().toISOString().slice(0, 10),
    allDays: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--db") opts.db = argv[++i];
    else if (argv[i] === "--day") opts.day = argv[++i];
    else if (argv[i] === "--all-days") opts.allDays = true;
    else {
      console.error(`unknown flag ${argv[i]}`);
      process.exit(2);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (!existsSync(opts.db)) {
  console.error(`privacy-audit: no database at ${opts.db}`);
  process.exit(2);
}

const db = new Database(opts.db, { readonly: true });
const where = opts.allDays ? "" : `WHERE e.ts >= ? AND e.ts < ?`;
const params = opts.allDays ? [] : [`${opts.day}T00:00:00`, `${opts.day}T23:59:59.999`];

const rows = db
  .prepare(
    `SELECT e.id, e.ts, e.source_type, e.kind, e.text, e.payload_json, e.raw_json
       FROM events e ${where}`,
  )
  .all(...params);

const findings = [];
for (const row of rows) {
  const haystack = `${row.text ?? ""}\n${row.payload_json ?? ""}\n${row.raw_json ?? ""}`.toLowerCase();
  for (const marker of PASSWORD_MANAGER_MARKERS) {
    if (haystack.includes(marker)) {
      findings.push({ id: row.id, ts: row.ts, source: row.source_type, kind: row.kind, rule: "password_manager", marker });
      break;
    }
  }
  for (const marker of PRIVATE_MARKERS) {
    if (haystack.includes(marker)) {
      findings.push({ id: row.id, ts: row.ts, source: row.source_type, kind: row.kind, rule: "private_window", marker });
      break;
    }
  }
}

const scope = opts.allDays ? "all days" : opts.day;
console.log(`privacy-audit: scanned ${rows.length} event(s) (${scope}) in ${opts.db}`);
if (findings.length === 0) {
  console.log("privacy-audit: CLEAN — no incognito/private-browsing or password-manager content in the log");
  process.exit(0);
}
console.error(`privacy-audit: ${findings.length} FINDING(S):`);
for (const f of findings) {
  console.error(`  ${f.ts}  ${f.id}  [${f.rule}] via "${f.marker}"  (${f.source}/${f.kind})`);
}
process.exit(1);
