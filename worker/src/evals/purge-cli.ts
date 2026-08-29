// ===========================================================================
// [CODE] `npm run purge:eval-data` — remove eval/fixture rows that shipped
// 13.4.1 wrote into a real home (defect fix).
//
//   npm run purge:eval-data                      dry run against ~/SuperTwinV13
//   npm run purge:eval-data -- --db /path/st.db  dry run against one file
//   npm run purge:eval-data -- --confirm         actually delete
//
// SAFE BY DEFAULT. Without --confirm it prints the survey and exits; no row
// is removed. With --confirm it prints the SAME survey, then hands the matched
// ids to the honest delete-cascade so every derived episode, claim, task,
// decision and FTS row goes with them.
//
// The one write a dry run does make is the shared connection module's
// migration step (getDb() migrates whatever file it opens) — worth knowing if
// you point --db at an archived copy.
//
// Exit codes: 0 survey printed / delete succeeded · 3 bad flag.
// ===========================================================================

import { pathToFileURL } from "node:url";

import { closeDb, resolveDbPath } from "../db/connection.js";
import { purgeEvalData, renderPurge, renderSurvey, surveyEvalData } from "./purge.js";

export interface PurgeCliOptions {
  confirm: boolean;
  /** Explicit DB file; otherwise the worker's normal resolution applies. */
  db: string | null;
  /** How many example rows the dry run prints. */
  sample: number;
}

export function parsePurgeArgs(argv: readonly string[]): PurgeCliOptions {
  const options: PurgeCliOptions = { confirm: false, db: null, sample: 8 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--confirm":
        options.confirm = true;
        break;
      case "--db":
        options.db = next();
        break;
      case "--sample": {
        const n = Number(next());
        if (!Number.isFinite(n) || n < 0) throw new Error("--sample needs a non-negative number");
        options.sample = Math.floor(n);
        break;
      }
      case "--dry-run":
        options.confirm = false;
        break;
      default:
        throw new Error(`unknown flag ${arg}`);
    }
  }
  return options;
}

export async function main(
  argv: readonly string[],
  out: (line: string) => void = console.log,
): Promise<number> {
  let options: PurgeCliOptions;
  try {
    options = parsePurgeArgs(argv);
  } catch (err) {
    out(`purge-eval-data: ${(err as Error).message}`);
    return 3;
  }

  const prev = process.env.SUPERTWIN_DB_PATH;
  if (options.db) {
    process.env.SUPERTWIN_DB_PATH = options.db;
    closeDb();
  }
  const dbPath = resolveDbPath();

  try {
    if (!options.confirm) {
      out(renderSurvey(surveyEvalData(dbPath), options.sample));
      return 0;
    }

    // --confirm still shows the survey: the operator sees exactly what went.
    const result = purgeEvalData();
    result.survey.db_path = dbPath;
    out(renderSurvey(result.survey, options.sample, "what was removed"));
    out("");
    out(renderPurge(result));
    return 0;
  } finally {
    if (options.db) {
      closeDb();
      if (prev === undefined) delete process.env.SUPERTWIN_DB_PATH;
      else process.env.SUPERTWIN_DB_PATH = prev;
    }
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(`purge-eval-data: ${(err as Error).stack ?? String(err)}`);
      process.exitCode = 3;
    });
}
