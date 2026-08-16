// ===========================================================================
// [CODE] Category V executor — the real embedder calibration (retrieval/*).
//
// Category V is `[CODE]` and, crucially, must run OFFLINE: measuring a floor
// on the real `multilingual-e5-small` would mean downloading 100 MB of ONNX
// weights inside `npm run eval`. It instead measures the floor on the
// CONSTRUCTED reference corpus that item 0.7 built for exactly this purpose —
// vectors with the geometry e5 actually produces on chat text, so the floor
// lands in the same 0.75–0.85 band the architecture measured.
//
// `measureFloor`, `normalizedScore`, `USE_CASE_BARS`, `calibrationFor` and
// `scoreCalibratedPair` are all the product's own; nothing here re-derives a
// threshold. The scenario format mirrors the accounting executor's:
//
//   floor|pairs=1000|use_case=entity_name|model=e5-small   measure + persist
//   score|cos=0.86|floor=0.83                              the normalisation
//   bars|use_case=arc_topic                                the per-use-case row
//   pair|use_case=entity_name|cos=0.93                     route a pair
//   swap|model=bge-small                                   a model with no calib
//   stale|use_case=claim_text|age_days=45                  a calibration too old
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, runMigrations } from "../../db/connection.js";
import { putCalib, readCalib, type CalibUseCase } from "../../db/calib.js";
import {
  CALIB_USE_CASES,
  calibrationFor,
  scoreCalibratedPair,
  similarityRungEnabled,
  USE_CASE_BARS,
} from "../../retrieval/calibration.js";
import { measureFloor, normalizedScore, MIN_CALIB_PAIRS } from "../../retrieval/calibration-floor.js";
import { referenceCorpus } from "../../retrieval/__fixtures__/reference-corpus.js";
import type { Executor, Produced } from "../runner.js";

interface ScenarioLine {
  tag: string;
  fields: Record<string, string>;
}

function parseScenario(text: string): ScenarioLine[] {
  const out: ScenarioLine[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const parts = line.split("|");
    const tag = (parts.shift() ?? "").trim();
    const fields: Record<string, string> = {};
    for (const part of parts) {
      const eq = part.indexOf("=");
      if (eq === -1) throw new Error(`calib scenario: field without '=' in ${JSON.stringify(part)}`);
      fields[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    out.push({ tag, fields });
  }
  return out;
}

function num(fields: Record<string, string>, key: string, fallback: number): number {
  const raw = fields[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`calib scenario: ${key}=${raw} is not a number`);
  return n;
}

function useCaseOf(fields: Record<string, string>, fallback: CalibUseCase = "entity_name"): CalibUseCase {
  const raw = fields.use_case;
  if (raw === undefined) return fallback;
  if (!(CALIB_USE_CASES as readonly string[]).includes(raw)) {
    throw new Error(`calib scenario: ${raw} is not one of ${CALIB_USE_CASES.join(" ")}`);
  }
  return raw as CalibUseCase;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export const calibExecutor: Executor = ({ response }) => {
  const dir = mkdtempSync(join(tmpdir(), "st-eval-calib-"));
  const previous = process.env.SUPERTWIN_DB_PATH;
  process.env.SUPERTWIN_DB_PATH = join(dir, "eval.db");
  closeDb();
  try {
    return runScenario(response);
  } finally {
    closeDb();
    if (previous === undefined) delete process.env.SUPERTWIN_DB_PATH;
    else process.env.SUPERTWIN_DB_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
};

function runScenario(response: string): Produced {
  runMigrations();

  const output: Record<string, unknown> = {};
  const state: Record<string, unknown> = {};
  const metrics: Record<string, number> = {};
  const now = Date.parse("2026-08-15T00:00:00.000Z");

  for (const { tag, fields } of parseScenario(response)) {
    switch (tag) {
      case "floor": {
        const useCase = useCaseOf(fields);
        const model = fields.model ?? "e5-small";
        const pairs = num(fields, "pairs", MIN_CALIB_PAIRS);
        // Enough documents that `pairs` distinct pairs genuinely exist.
        const corpus = referenceCorpus({ count: num(fields, "docs", 400), seed: num(fields, "seed", 7) });
        const measured = measureFloor(corpus.vectors, { pairs });
        putCalib({
          model,
          useCase,
          floor: measured.floor,
          nPairs: measured.nPairs,
          measuredAt: new Date(now).toISOString(),
        });
        const persisted = readCalib(model, useCase);
        state.floor = round3(measured.floor);
        state.floor_in_band = measured.floor >= 0.7 && measured.floor <= 0.9;
        state.floor_doc_band = measured.floor >= 0.75 && measured.floor <= 0.85;
        state.n_pairs = measured.nPairs;
        state.persisted = persisted !== null;
        state.persisted_floor = persisted === null ? null : round3(persisted.floor);
        state.persisted_key = persisted === null ? null : `${model}/${useCase}`;
        metrics.floor = measured.floor;
        metrics.n_pairs = measured.nPairs;
        break;
      }
      case "score": {
        const cos = num(fields, "cos", 0);
        const floor = num(fields, "floor", 0.83);
        state.normalised = round3(normalizedScore(cos, floor));
        state.cosine = cos;
        state.floor = floor;
        break;
      }
      case "bars": {
        const useCase = useCaseOf(fields);
        const bars = USE_CASE_BARS[useCase];
        state.use_case = useCase;
        state.bind = bars.bind;
        state.band = bars.band;
        // The one ordering the architecture states outright (§10.3).
        state.arc_above_episode =
          USE_CASE_BARS.arc_topic.bind > USE_CASE_BARS.episode_topic.bind &&
          USE_CASE_BARS.arc_topic.band > USE_CASE_BARS.episode_topic.band;
        state.has_own_row = Object.prototype.hasOwnProperty.call(USE_CASE_BARS, useCase);
        break;
      }
      case "pair": {
        const useCase = useCaseOf(fields);
        const model = fields.model ?? "e5-small";
        const decision = scoreCalibratedPair(useCase, num(fields, "cos", 0), { model, now });
        state.route = decision.route;
        state.verdict = decision.verdict;
        state.score = decision.score === null ? null : round3(decision.score);
        state.reported_cosine = decision.cosine;
        state.calibration_state = decision.calibration.state;
        break;
      }
      case "swap": {
        // A new embedding model has no calibration of its own, so every rung
        // must block until the floor is re-measured — never inherit the old one.
        const model = fields.model ?? "bge-small";
        const before = CALIB_USE_CASES.map((useCase) => ({
          use_case: useCase,
          state: calibrationFor(useCase, { model, now }).state,
          enabled: similarityRungEnabled(useCase, { model, now }),
        }));
        state.after_swap = before;
        state.any_rung_enabled = before.some((r) => r.enabled);
        state.all_blocked = before.every((r) => !r.enabled);
        break;
      }
      case "stale": {
        const useCase = useCaseOf(fields);
        const model = fields.model ?? "e5-small";
        const ageDays = num(fields, "age_days", 45);
        putCalib({
          model,
          useCase,
          floor: num(fields, "floor", 0.81),
          nPairs: num(fields, "pairs", MIN_CALIB_PAIRS),
          measuredAt: new Date(now - ageDays * 86_400_000).toISOString(),
        });
        const verdict = calibrationFor(useCase, { model, now });
        state.calibration_state = verdict.state;
        state.rung_enabled = similarityRungEnabled(useCase, { model, now });
        // With a stale floor the pair is not scored at all — no cosine, no
        // guessed threshold, just a route away from the [ML] rung.
        const decision = scoreCalibratedPair(useCase, num(fields, "cos", 0.93), { model, now });
        state.route = decision.route;
        state.verdict = decision.verdict;
        state.score = decision.score;
        break;
      }
      default:
        throw new Error(`calib scenario: unknown record ${JSON.stringify(tag)}`);
    }
  }

  return { output, state, metrics };
}
