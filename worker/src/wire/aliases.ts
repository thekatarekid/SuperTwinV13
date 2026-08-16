// ===========================================================================
// [CODE] STW-2 alias namespaces — arch §5.2.
//
// One WhatsApp event id is 51 characters ≈ 13–15 tokens. On the prior corpus
// 37.2 % of output characters were raw event ids, echoed back 3,683 times.
// Replacing one with `7` costs a single token; that is the whole trick.
//
// Two rules govern this file:
//
//   * Alias tables are PROMPT-LOCAL and never persisted. A fresh table per
//     prompt, thrown away with the response.
//   * Resolution is a RANGE CHECK, never a string match. `a9` in a roster of
//     seven resolves to `null` — "the model did not say" — and never to a
//     fuzzy match on some entity whose name looked close. A roster miss is
//     honest (§5.8.6).
// ===========================================================================

/** Wire prefix per namespace (§5.2). `self` is reserved and never numbered. */
export const ALIAS_PREFIX = {
  entity: "a",
  stream: "c",
  arc: "n",
  proposed: "k",
  episode: "e",
  loop: "t",
} as const;

export type AliasNamespace = keyof typeof ALIAS_PREFIX;

export const ALIAS_NAMESPACES = Object.keys(ALIAS_PREFIX) as AliasNamespace[];

const PREFIX_TO_NAMESPACE = new Map<string, AliasNamespace>(
  ALIAS_NAMESPACES.map((ns) => [ALIAS_PREFIX[ns], ns]),
);

/** The me entity. Reserved: it is never numbered and never on the roster. */
export const SELF_ALIAS = "self";

// ---- base 36 ---------------------------------------------------------------

/** `a`=10 … `z`=35, `10`=36, `1a`=46 (§5.2.1). Lowercase on emit. */
export function toBase36(n: number): string {
  if (!Number.isInteger(n) || n < 0) return "";
  return n.toString(36);
}

/** Strict inverse: only `[0-9a-z]+` parses, and nothing else ever does. */
export function fromBase36(s: string): number | null {
  if (typeof s !== "string") return null;
  const t = s.trim().toLowerCase();
  if (!/^[0-9a-z]+$/.test(t)) return null;
  const n = parseInt(t, 36);
  return Number.isSafeInteger(n) ? n : null;
}

// ---- resolution ------------------------------------------------------------

export type ResolvedKind = AliasNamespace | "self" | "event" | "minted";

export interface AliasRef {
  kind: ResolvedKind;
  /** The token exactly as the model wrote it (trimmed). */
  token: string;
  /** 1-based position inside the namespace, or the event number. */
  index: number | null;
  /** The real id this alias stands for; `null` for a `+Name` mint. */
  id: string | null;
  /** Verbatim name for a `+Name` mint — code dedupes and mints the entity. */
  name: string | null;
}

/**
 * The shape every resolution returns. Exactly one side is populated for a
 * stated token; both are `null` when the field was blank ("not stated").
 */
export interface AliasResolution {
  resolved: AliasRef | null;
  unresolved: string | null;
}

export interface AliasListResolution {
  resolved: AliasRef[];
  unresolved: string[];
}

export interface AliasEntry {
  token: string;
  id: string;
  label: string | null;
}

export interface AliasTable {
  /** Mint (or reuse) the alias for a real id. Stable within the prompt. */
  mint(ns: AliasNamespace, id: string, label?: string): string;
  /** The alias already minted for this id, or `null`. Never mints. */
  tokenFor(ns: AliasNamespace, id: string): string | null;
  /** How many aliases exist in a namespace — the range check's upper bound. */
  size(ns: AliasNamespace): number;
  entries(ns: AliasNamespace): AliasEntry[];
  /** Mint (or reuse) the base-36 number for an event id. */
  mintEvent(eventId: string): string;
  eventToken(eventId: string): string | null;
  eventId(token: string): string | null;
  eventCount(): number;
  /** Range-checked resolution of a single token. */
  resolve(token: string): AliasResolution;
  /** Range-checked resolution of a comma list or a token array. */
  resolveList(tokens: string | readonly string[]): AliasListResolution;
}

const ABSENT = new Set(["", "-", "–", "—", "―"]);
const ALIAS_TOKEN_RE = /^([acnket])([0-9]+)$/;

/**
 * A prompt-local alias table. Every map is private to this closure — there is
 * no way to reach in and mutate one, and no way for a table to outlive the
 * prompt that made it.
 */
export function createAliasTable(): AliasTable {
  const byId = new Map<AliasNamespace, Map<string, number>>();
  const byIndex = new Map<AliasNamespace, Map<number, AliasEntry>>();
  for (const ns of ALIAS_NAMESPACES) {
    byId.set(ns, new Map());
    byIndex.set(ns, new Map());
  }
  const eventByIndex = new Map<number, string>();
  const eventById = new Map<string, number>();

  function ids(ns: AliasNamespace): Map<string, number> {
    return byId.get(ns) as Map<string, number>;
  }
  function idx(ns: AliasNamespace): Map<number, AliasEntry> {
    return byIndex.get(ns) as Map<number, AliasEntry>;
  }

  function mint(ns: AliasNamespace, id: string, label?: string): string {
    const existing = ids(ns).get(id);
    if (existing !== undefined) {
      const entry = idx(ns).get(existing);
      if (entry && label && !entry.label) entry.label = label;
      return `${ALIAS_PREFIX[ns]}${existing}`;
    }
    const n = ids(ns).size + 1;
    const token = `${ALIAS_PREFIX[ns]}${n}`;
    ids(ns).set(id, n);
    idx(ns).set(n, { token, id, label: label ?? null });
    return token;
  }

  function resolve(raw: string): AliasResolution {
    const token = typeof raw === "string" ? raw.trim() : "";
    if (ABSENT.has(token)) return { resolved: null, unresolved: null };

    if (token.toLowerCase() === SELF_ALIAS) {
      return { resolved: { kind: "self", token, index: null, id: SELF_ALIAS, name: null }, unresolved: null };
    }

    // `+Name` — an entity not on the roster. Verbatim name, minted by code
    // after dedupe. It is not unresolved: the model told us exactly who.
    if (token.startsWith("+") && token.length > 1) {
      return {
        resolved: { kind: "minted", token, index: null, id: null, name: token.slice(1).trim() },
        unresolved: null,
      };
    }

    const m = ALIAS_TOKEN_RE.exec(token.toLowerCase());
    if (m) {
      const ns = PREFIX_TO_NAMESPACE.get(m[1]) as AliasNamespace;
      const n = Number(m[2]);
      // THE RANGE CHECK. Not a string match, not a nearest neighbour.
      if (n >= 1 && n <= ids(ns).size) {
        const entry = idx(ns).get(n) as AliasEntry;
        return { resolved: { kind: ns, token, index: n, id: entry.id, name: entry.label }, unresolved: null };
      }
      return { resolved: null, unresolved: token };
    }

    // A bare base-36 number is an event.
    const n = fromBase36(token);
    if (n !== null) {
      const id = eventByIndex.get(n);
      if (id !== undefined) {
        return { resolved: { kind: "event", token, index: n, id, name: null }, unresolved: null };
      }
      return { resolved: null, unresolved: token };
    }

    return { resolved: null, unresolved: token };
  }

  return {
    mint,
    tokenFor(ns, id) {
      const n = ids(ns).get(id);
      return n === undefined ? null : `${ALIAS_PREFIX[ns]}${n}`;
    },
    size(ns) {
      return ids(ns).size;
    },
    entries(ns) {
      return [...idx(ns).entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => ({ ...e }));
    },
    mintEvent(eventId) {
      const existing = eventById.get(eventId);
      if (existing !== undefined) return toBase36(existing);
      const n = eventById.size + 1;
      eventById.set(eventId, n);
      eventByIndex.set(n, eventId);
      return toBase36(n);
    },
    eventToken(eventId) {
      const n = eventById.get(eventId);
      return n === undefined ? null : toBase36(n);
    },
    eventId(token) {
      const n = fromBase36(token);
      return n === null ? null : (eventByIndex.get(n) ?? null);
    },
    eventCount() {
      return eventById.size;
    },
    resolve,
    resolveList(tokens) {
      const list = typeof tokens === "string" ? tokens.split(",") : [...tokens];
      const resolved: AliasRef[] = [];
      const unresolved: string[] = [];
      for (const t of list) {
        const r = resolve(t);
        if (r.resolved) resolved.push(r.resolved);
        else if (r.unresolved !== null) unresolved.push(r.unresolved);
      }
      return { resolved, unresolved };
    },
  };
}
