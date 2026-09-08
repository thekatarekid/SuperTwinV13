// ===========================================================================
// What models can this machine's `claude` CLI actually reach?
//
// The per-step picker used to offer three strings — "haiku", "sonnet", "opus"
// — which is neither the list the adapter can reach nor a list anyone can
// reason about: a bare family name does not say which version will run, what
// it costs, or whether it has a reasoning dial at all. This module answers all
// three by READING THE CLI, rather than by hardcoding a guess that goes stale
// the day the CLI updates.
//
// WHERE THE ANSWER COMES FROM. `claude` exposes no `models list` subcommand
// (checked: 2.1.246 has agents/auth/doctor/mcp/plugin/project/... and nothing
// that enumerates models), and an unknown `--model` is answered with a generic
// "may not exist" rather than a list. What the binary DOES carry is its own
// catalogue, verbatim, introduced by a comment string it ships with:
//
//   {"//":"Hand-maintained baked-in model catalog — the source of truth for
//    per-model provider IDs and metadata. …",schema_version:1,
//    pricing_tiers:{…},models:[{id:"claude-opus-4-5",family:"opus",
//    display_name:"Opus 4.5",provider_ids:{first_party:"claude-opus-4-5-20251101",…},
//    pricing:"tier_5_25",capabilities:["context_management"],…}],aliases:{…}}
//
// That object is the CLI's own source of truth for exactly the three things
// the picker needs: the versioned id `--model` takes, the per-million price,
// and which reasoning levels the model accepts. So discovery is: find that
// object in the executable, parse it, project it.
//
// It is a bundled JS object literal, not JSON — bare keys, `!0`/`!1` for the
// booleans, `1e6` for a number — so it is read by a small literal parser
// below. Nothing is eval'd: the parser only ever produces data.
//
// WHEN IT FAILS. A CLI that moved the marker, a build that minified it
// differently, no `claude` on the box at all — every one of those falls back
// to the curated versioned registry in models.ts, and the mode is REPORTED
// ("discovered" vs "fallback") so Settings can say which list you are looking
// at instead of quietly showing a stale one.
// ===========================================================================

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { createHash } from "node:crypto";

import type {
  ProviderModel,
  ProviderModelCatalogue,
  ThinkingBudget,
} from "../types.js";
import { FALLBACK_MODEL_CATALOG, type CuratedModel } from "./models.js";
import { resolveClaudeBin } from "./cli.js";

// ---------------------------------------------------------------------------
// What a picker row is
// ---------------------------------------------------------------------------

/** Canonical order of the reasoning ladder; every level list is sorted by it. */
export const THINKING_ORDER: readonly ThinkingBudget[] = [
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export interface ClaudeModelInfo {
  /** What is passed to `claude --model`. Versioned for a real model. */
  id: string;
  /** "Opus 4.5" — what the row reads as. */
  label: string;
  family: string;
  /** True for a moving alias ("opus"), false for a pinned version. */
  alias: boolean;
  /** For an alias: the pinned id it currently resolves to. */
  resolvesTo: string | null;
  /** USD per million input tokens, or null when the catalogue omits it. */
  inputPerMTok: number | null;
  /** USD per million output tokens. */
  outputPerMTok: number | null;
  /**
   * The reasoning levels this model actually accepts. EMPTY means the model
   * has no reasoning dial — the second dropdown is disabled rather than
   * offering a choice that does nothing.
   */
  thinkingLevels: ThinkingBudget[];
  /** The level the model runs at when nothing is chosen. */
  defaultThinking: ThinkingBudget | null;
  /**
   * True when the levels drive the CLI's `--effort` flag; false when they
   * drive MAX_THINKING_TOKENS (the older extended-thinking ladder, §4.3).
   */
  effort: boolean;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  hidden: boolean;
}

export interface ModelCatalog {
  /**
   * Where this list came from, and it is three answers rather than two:
   * "discovered" = read out of this machine's CLI just now; "cached" = read
   * out of it before, and this boot could not re-read it; "fallback" = the
   * curated registry. A remembered list served as a live one is the same lie
   * as a hardcoded one served as a live one.
   */
  mode: "discovered" | "cached" | "fallback";
  /** The binary it was read from, or why there was nothing to read. */
  source: string;
  /** Set only in fallback mode: what went wrong. */
  error: string | null;
  discoveredAt: string;
  /** The CLI's preferred model/alias when it publishes one. */
  defaultModelId: string | null;
  models: ClaudeModelInfo[];
}

// ---------------------------------------------------------------------------
// A minimal JS object-literal reader.
//
// Handles exactly what the bundled catalogue uses: objects with bare or quoted
// keys, arrays, strings in any of the three quote styles, numbers (including
// `1e6`), `!0`/`!1`, true/false/null/undefined. Anything else throws, which is
// the point — a shape this does not recognise must fall back, not guess.
// ---------------------------------------------------------------------------

type Literal = string | number | boolean | null | undefined | Literal[] | { [k: string]: Literal };

class LiteralReader {
  private i = 0;
  constructor(private readonly src: string) {}

  /** Parse one value starting at `from`; returns it plus the index after it. */
  static parseAt(src: string, from: number): { value: Literal; end: number } {
    const r = new LiteralReader(src);
    r.i = from;
    const value = r.value();
    return { value, end: r.i };
  }

  private ws(): void {
    while (this.i < this.src.length && /\s/.test(this.src[this.i]!)) this.i += 1;
  }

  private expect(ch: string): void {
    if (this.src[this.i] !== ch) {
      throw new Error(`expected ${ch} at ${this.i}, found ${this.src[this.i] ?? "EOF"}`);
    }
    this.i += 1;
  }

  private value(): Literal {
    this.ws();
    const c = this.src[this.i];
    if (c === undefined) throw new Error("unexpected end of literal");
    if (c === "{") return this.object();
    if (c === "[") return this.array();
    if (c === '"' || c === "'" || c === "`") return this.string();
    if (c === "!") {
      // The bundler's `!0` / `!1` for true / false.
      const next = this.src[this.i + 1];
      if (next !== "0" && next !== "1") throw new Error(`bad negation at ${this.i}`);
      this.i += 2;
      return next === "0";
    }
    if (this.src.startsWith("true", this.i)) {
      this.i += 4;
      return true;
    }
    if (this.src.startsWith("false", this.i)) {
      this.i += 5;
      return false;
    }
    if (this.src.startsWith("null", this.i)) {
      this.i += 4;
      return null;
    }
    if (this.src.startsWith("undefined", this.i)) {
      this.i += 9;
      return undefined;
    }
    return this.number();
  }

  private object(): { [k: string]: Literal } {
    this.expect("{");
    const out: { [k: string]: Literal } = {};
    this.ws();
    if (this.src[this.i] === "}") {
      this.i += 1;
      return out;
    }
    for (;;) {
      this.ws();
      const key =
        this.src[this.i] === '"' || this.src[this.i] === "'" || this.src[this.i] === "`"
          ? this.string()
          : this.bareKey();
      this.ws();
      this.expect(":");
      out[key] = this.value();
      this.ws();
      if (this.src[this.i] === ",") {
        this.i += 1;
        this.ws();
        // A trailing comma before `}` is legal in the source this reads.
        if (this.src[this.i] === "}") {
          this.i += 1;
          return out;
        }
        continue;
      }
      this.expect("}");
      return out;
    }
  }

  private array(): Literal[] {
    this.expect("[");
    const out: Literal[] = [];
    this.ws();
    if (this.src[this.i] === "]") {
      this.i += 1;
      return out;
    }
    for (;;) {
      out.push(this.value());
      this.ws();
      if (this.src[this.i] === ",") {
        this.i += 1;
        this.ws();
        if (this.src[this.i] === "]") {
          this.i += 1;
          return out;
        }
        continue;
      }
      this.expect("]");
      return out;
    }
  }

  private bareKey(): string {
    const start = this.i;
    while (this.i < this.src.length && /[A-Za-z0-9_$]/.test(this.src[this.i]!)) this.i += 1;
    if (this.i === start) throw new Error(`expected a key at ${start}`);
    return this.src.slice(start, this.i);
  }

  private string(): string {
    const quote = this.src[this.i]!;
    this.i += 1;
    let out = "";
    while (this.i < this.src.length) {
      const c = this.src[this.i]!;
      if (c === "\\") {
        const esc = this.src[this.i + 1]!;
        this.i += 2;
        if (esc === "u") {
          out += String.fromCharCode(parseInt(this.src.slice(this.i, this.i + 4), 16));
          this.i += 4;
        } else if (esc === "n") out += "\n";
        else if (esc === "t") out += "\t";
        else if (esc === "r") out += "\r";
        else out += esc;
        continue;
      }
      if (c === quote) {
        this.i += 1;
        return out;
      }
      out += c;
      this.i += 1;
    }
    throw new Error("unterminated string");
  }

  private number(): number {
    const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.src.slice(this.i));
    if (!m) throw new Error(`expected a number at ${this.i}`);
    this.i += m[0].length;
    return Number(m[0]);
  }
}

// ---------------------------------------------------------------------------
// Finding the catalogue inside the executable
// ---------------------------------------------------------------------------

/**
 * The comment the CLI ships at the head of its own catalogue. Anchoring on the
 * `{"//":` that opens the object (rather than on the prose) means the match IS
 * the parse start — there is no walking backwards to guess where it began.
 */
export const CATALOG_MARKER = '{"//":"Hand-maintained baked-in model catalog';

/** Read in 4 MB windows, overlapping by the marker length so a split cannot hide it. */
const SCAN_CHUNK = 4 * 1024 * 1024;
/** The catalogue is ~15 KB; 1 MB is head-room, not a guess at its size. */
const CATALOG_WINDOW = 1024 * 1024;

/** Byte offset of the catalogue in `path`, or -1. Streamed: the file is ~230 MB. */
export function findCatalogOffset(path: string): number {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const overlap = CATALOG_MARKER.length;
    const buf = Buffer.alloc(SCAN_CHUNK);
    let pos = 0;
    while (pos < size) {
      const read = readSync(fd, buf, 0, SCAN_CHUNK, pos);
      if (read <= 0) break;
      const at = buf.subarray(0, read).indexOf(CATALOG_MARKER, 0, "latin1");
      if (at >= 0) return pos + at;
      pos += Math.max(read - overlap, 1);
    }
    return -1;
  } finally {
    closeSync(fd);
  }
}

/** The catalogue object as parsed data, or null when it is not in this binary. */
export function readCatalogFrom(path: string): { [k: string]: Literal } | null {
  const offset = findCatalogOffset(path);
  if (offset < 0) return null;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(CATALOG_WINDOW);
    const read = readSync(fd, buf, 0, CATALOG_WINDOW, offset);
    const text = buf.subarray(0, read).toString("utf8");
    const { value } = LiteralReader.parseAt(text, 0);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value as { [k: string]: Literal };
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Projecting the catalogue onto picker rows
// ---------------------------------------------------------------------------

/**
 * The model generation as a number: 3.5, 3.7, 4.5, 5. Both id shapes the
 * catalogue uses reduce the same way, because the digits are the digits
 * wherever they sit — `claude-3-5-haiku` and `claude-haiku-4-5` both answer.
 */
export function generationOf(id: string): number {
  const nums = id
    .replace(/^claude-/, "")
    .split("-")
    .filter((p) => /^\d+$/.test(p))
    .map(Number);
  if (nums.length === 0) return 0;
  return nums[0]! + (nums[1] ?? 0) / 10;
}

/** Extended thinking arrived with Claude 3.7; 3.5 and older have no dial. */
const FIRST_THINKING_GENERATION = 3.7;

/**
 * Which reasoning levels a model accepts, derived from what the catalogue says
 * about it rather than from a list of model names:
 *
 *   - `effort` in its capabilities  → the CLI's `--effort` ladder. `xhigh` and
 *     `max` are separate capabilities, so they are only offered where they are
 *     claimed; `off` is offered unless the model `rejects_disabled_thinking`.
 *   - otherwise, 3.7 or newer       → the MAX_THINKING_TOKENS ladder (§4.3),
 *     which is the lever this adapter has always had for those models.
 *   - otherwise                     → none. The control is disabled, because a
 *     dial that does nothing is worse than no dial.
 */
export function thinkingLevelsFor(
  catalogId: string,
  capabilities: readonly string[],
): { levels: ThinkingBudget[]; effort: boolean } {
  if (capabilities.includes("effort")) {
    const levels: ThinkingBudget[] = ["low", "medium", "high"];
    if (capabilities.includes("xhigh_effort")) levels.push("xhigh");
    if (capabilities.includes("max_effort")) levels.push("max");
    if (!capabilities.includes("rejects_disabled_thinking")) levels.unshift("off");
    return { levels: sortLevels(levels), effort: true };
  }
  if (generationOf(catalogId) >= FIRST_THINKING_GENERATION) {
    return { levels: [...THINKING_ORDER], effort: false };
  }
  return { levels: [], effort: false };
}

function sortLevels(levels: ThinkingBudget[]): ThinkingBudget[] {
  return [...new Set(levels)].sort(
    (a, b) => THINKING_ORDER.indexOf(a) - THINKING_ORDER.indexOf(b),
  );
}

function str(v: Literal): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: Literal): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function maxOutputTokens(v: Literal): number | null {
  const direct = num(v);
  if (direct !== null) return direct;
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const limits = v as { [k: string]: Literal };
  return num(limits.upper) ?? num(limits.default);
}

/** Turn one parsed catalogue into picker rows. Throws if the shape is wrong. */
export function projectCatalog(raw: { [k: string]: Literal }): ClaudeModelInfo[] {
  const tiers = (raw.pricing_tiers ?? {}) as { [k: string]: Literal };
  const entries = raw.models;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("catalogue carries no models");
  }

  const byCatalogId = new Map<string, ClaudeModelInfo>();
  const models: ClaudeModelInfo[] = [];

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const e = entry as { [k: string]: Literal };
    const catalogId = str(e.id);
    if (!catalogId) continue;
    const providerIds = (e.provider_ids ?? {}) as { [k: string]: Literal };
    // The versioned id is what `--model` is given: the family key ("opus")
    // moves, the first-party id does not.
    const id = str(providerIds.first_party) ?? catalogId;
    const capabilities = Array.isArray(e.capabilities)
      ? e.capabilities.filter((c): c is string => typeof c === "string")
      : [];
    const pricing =
      typeof e.pricing === "string"
        ? ((tiers[e.pricing] ?? {}) as { [k: string]: Literal })
        : typeof e.pricing === "object" && e.pricing !== null && !Array.isArray(e.pricing)
          ? (e.pricing as { [k: string]: Literal })
          : {};
    const context = (e.context ?? {}) as { [k: string]: Literal };
    const { levels, effort } = thinkingLevelsFor(catalogId, capabilities);
    const defaultThinking = str(e.default_effort) as ThinkingBudget | null;
    const row: ClaudeModelInfo = {
      id,
      label: str(e.display_name) ?? catalogId,
      family: str(e.family) ?? "other",
      alias: false,
      resolvesTo: null,
      inputPerMTok: num(pricing.input),
      outputPerMTok: num(pricing.output),
      thinkingLevels: levels,
      defaultThinking:
        defaultThinking && levels.includes(defaultThinking)
          ? defaultThinking
          : (levels[0] ?? null),
      effort,
      contextWindow: num(context.window),
      maxOutputTokens: maxOutputTokens(e.max_output_tokens),
      hidden: e.hidden === true || e.is_hidden === true,
    };
    models.push(row);
    byCatalogId.set(catalogId, row);
  }

  // The family aliases the CLI also accepts. They stay in the list because
  // every install that predates this fix has one of them PERSISTED as its
  // per-step choice — dropping them would silently invalidate live settings —
  // but each one names the version it currently resolves to, so no row in the
  // picker is a bare family name any more.
  const aliases = (raw.aliases ?? {}) as { [k: string]: Literal };
  for (const [alias, def] of Object.entries(aliases)) {
    if (typeof def !== "object" || def === null || Array.isArray(def)) continue;
    const target = str((def as { [k: string]: Literal }).default);
    const targetRow = target ? byCatalogId.get(target) : undefined;
    if (!targetRow) continue;
    models.push({
      ...targetRow,
      id: alias,
      label: `${alias[0]!.toUpperCase()}${alias.slice(1)} (latest → ${targetRow.label})`,
      alias: true,
      resolvesTo: targetRow.id,
    });
  }

  return models;
}

// ---------------------------------------------------------------------------
// The public entry point, with an in-memory cache
// ---------------------------------------------------------------------------

let cache: { key: string; catalog: ModelCatalog } | null = null;

/** Identity of the resolved CLI: path + size + mtime. A new build re-reads. */
function binaryKey(path: string): string {
  try {
    const st = statSync(path);
    return `${path}:${st.size}:${st.mtimeMs}`;
  } catch {
    return `${path}:absent`;
  }
}

/** The curated list, as a catalogue. Used whenever discovery cannot answer. */
export function fallbackCatalog(error: string): ModelCatalog {
  return {
    mode: "fallback",
    source: "curated registry (worker/src/providers/claude-local/models.ts)",
    error,
    discoveredAt: new Date().toISOString(),
    defaultModelId: "haiku",
    models: FALLBACK_MODEL_CATALOG.map(curatedToInfo),
  };
}

function curatedToInfo(m: CuratedModel): ClaudeModelInfo {
  return {
    id: m.id,
    label: m.label,
    family: m.family,
    alias: m.alias,
    resolvesTo: m.resolvesTo ?? null,
    inputPerMTok: m.inputPerMTok,
    outputPerMTok: m.outputPerMTok,
    thinkingLevels: [...m.thinkingLevels],
    defaultThinking: m.thinkingLevels[0] ?? null,
    effort: m.effort,
    contextWindow: m.contextWindow,
    maxOutputTokens: null,
    hidden: false,
  };
}

/**
 * Every model this machine's `claude` can reach, discovered from the CLI, with
 * the curated registry as the answer of last resort. Cached against the
 * binary's identity, so a CLI update is picked up and a settled one is free.
 */
export function discoverClaudeModels(): ModelCatalog {
  const bin = resolveClaudeBin();
  const key = binaryKey(bin);
  if (cache && cache.key === key) return cache.catalog;

  let catalog: ModelCatalog;
  try {
    const raw = readCatalogFrom(bin);
    if (!raw) throw new Error(`no baked model catalog found in ${bin}`);
    const models = projectCatalog(raw);
    if (models.length === 0) throw new Error("the catalog parsed but held no models");
    catalog = {
      mode: "discovered",
      source: bin,
      error: null,
      discoveredAt: new Date().toISOString(),
      defaultModelId: str(raw.best),
      models,
    };
  } catch (err) {
    catalog = fallbackCatalog(err instanceof Error ? err.message : String(err));
  }
  cache = { key, catalog };
  return catalog;
}

/** Test seam — the cache is process-wide by design. */
export function resetModelDiscoveryForTests(): void {
  cache = null;
}

function billingLabel(model: ClaudeModelInfo): string | null {
  if (model.inputPerMTok === null || model.outputPerMTok === null) return null;
  return `$${model.inputPerMTok}/MTok input · $${model.outputPerMTok}/MTok output`;
}

/** Map the Claude-specific picker catalogue onto the shared provider shape. */
export function mapClaudeProviderCatalogue(
  catalogue: ModelCatalog,
): ProviderModelCatalogue {
  const defaultModelId =
    catalogue.models.find(
      (model) => model.id === catalogue.defaultModelId && !model.hidden,
    )?.id ??
    catalogue.models.find((model) => model.id === "haiku" && !model.hidden)?.id ??
    catalogue.models.find((model) => !model.hidden)?.id ??
    null;
  const models: ProviderModel[] = catalogue.models.map((model) => ({
    id: model.id,
    displayName: model.label,
    isDefault: defaultModelId === model.id,
    hidden: model.hidden,
    inputModalities: ["text", "image"],
    reasoningValues: [...model.thinkingLevels],
    defaultReasoning: model.defaultThinking,
    supportsTools: true,
    supportsHostTools: true,
    supportsParallelToolCalls: true,
    supportsStructuredOutput: false,
    supportsStrictTools: false,
    supportsVerbosity: false,
    supportsPromptCacheKey: false,
    supportsPromptCacheOptions: false,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    billingLabel: billingLabel(model),
  }));
  const revision = createHash("sha256")
    .update(JSON.stringify(models))
    .digest("hex");
  return {
    providerId: "claude-local",
    mode: catalogue.mode,
    source: catalogue.source,
    discoveredAt: catalogue.discoveredAt,
    revision,
    error: catalogue.error,
    models,
  };
}

/** Discover Claude and expose it through the provider-neutral contract. */
export function discoverClaudeProviderCatalogue(): ProviderModelCatalogue {
  return mapClaudeProviderCatalogue(discoverClaudeModels());
}
