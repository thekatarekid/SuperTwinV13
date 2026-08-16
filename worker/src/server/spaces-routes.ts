// ===========================================================================
// [CODE] The Spaces surface's routes — arch §14.6, build item 3.10.
//
//   GET  /api/spaces                the page: counts, spaces, not-spaces, goals
//   POST /api/spaces/:id/archetype  { archetype }  the user's classification
//   POST /api/spaces/:id/relabel    { label }      the user's own words
//   POST /api/spaces/:id/pin        { pinned }     📌 the user promotion route
//   POST /api/spaces/:id/archive    { archived }   retire, or hand back to code
//   GET  /api/goals                 the life projects on their own
//
// ⚠ A SPACE IS A PROMOTED ARC (brief rule 6, `arcs/promote.ts`'s header). There
// is no `spaces` table and nothing here invents one: every read starts at
// `readSpaces()` — a `WHERE promoted = 1` over `arcs` — and every write goes
// through `arcs/promote-store.ts`, which owns the eight promotion fields and
// writes the `mutations` row for each flip. This file adds no business logic;
// it composes VIEW shapes out of the modules that already own the facts.
//
// Three consequences worth naming:
//
//  1. `[ why a space? ]` IS RE-DERIVED, NOT STORED. `promotionVerdict` is pure,
//     so the route recomputes it per space and renders `RouteEvidence.detail`
//     verbatim as `promotionRule`. A stored sentence could drift from the sweep
//     that promoted the arc; a recomputed one cannot.
//  2. CONTEXT CLAIMS ARE COMPUTED AT QUERY TIME (§14.6), never stored on the
//     space, and preferences are weighted first — the `weighted` flag says
//     which ordering rule surfaced each row.
//  3. THE SIGNAL STRIP IS THE WORKER'S LINE. §14.6 gives the surface one card
//     layout and eight archetypes, differentiated by icon, accent and strip;
//     the browser is not allowed to compose the strip (`src/tabs/spaces/
//     strip.ts` says so), so it is composed here — out of counted facts only,
//     and it is `null` when there is nothing to count.
//
// An empty database is a normal state, not an error: before the derivation
// pipeline has run there are no arcs, and the answer is a well-formed empty
// page (`spaces: []`, zeroed counts) rather than a 500.
// ===========================================================================

import { type IncomingMessage, type ServerResponse } from "node:http";

import { isArchetype, type Archetype, type ArchetypeSource } from "../arcs/archetype.js";
import {
  isPromotionRoute,
  promotionVerdict,
  SPACE_STATUSES,
  type PromotionRoute,
  type PromotionVerdict,
  type SpaceStatus,
} from "../arcs/promote.js";
import {
  applyPromotionVerdict,
  pinArc,
  readPromotionInput,
  readSpaces,
  setArchetype,
  setUserLabel,
  unpinArc,
  type SpaceRow,
} from "../arcs/promote-store.js";
import { getDb } from "../db/connection.js";
import { meEntityId } from "../entities/binding.js";
import { logMutation } from "../entities/merge.js";
import { readGoals } from "../goals/emerge.js";
import { readCoverage } from "../scheduler/queue.js";

/** The one actor a surface gesture may ever write under (§14.1). */
const USER_ACTOR = "user";

/** Every write here targets an arc — a space id IS an arc id. */
const TARGET_KIND = "arc";

/** Unpromoted arcs are browsable, not paginated: the newest handful is enough. */
const NOT_A_SPACE_LIMIT = 25;

/** Context is context, not a claims browser — §14.6 shows a few lines. */
const CONTEXT_CLAIM_LIMIT = 6;

/** The claim kind §14.6 weights first. Everything else keeps its own order. */
const WEIGHTED_CLAIM_KIND = "preference";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function jsonArray(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function marks(count: number): string {
  return new Array(count).fill("?").join(", ");
}

// ---------------------------------------------------------------------------
// The view shapes — `src/lib/spaces-client.ts` declares the same ones
// ---------------------------------------------------------------------------

export interface SpaceLoopView {
  id: string;
  intent: string;
  state: string;
  dueAt: string | null;
  ownerLabel: string;
  ownerIsSelf: boolean;
}

export interface SpaceContextClaimView {
  claimId: string;
  kind: string;
  text: string;
  confidence: number | null;
  weighted: boolean;
}

export interface SpaceView {
  /** A space id IS an arc id. Both names ship so neither can be forgotten. */
  id: string;
  arcId: string;
  label: string;
  labelSource: "model" | "user" | null;
  archetype: Archetype | null;
  archetypeSource: ArchetypeSource | null;
  status: SpaceStatus;
  promotionReason: PromotionRoute | null;
  signalStrip: string | null;
  pinned: boolean;
  dormantNote: string | null;
  stillGrowing: boolean;
  provisional: boolean;
  endsAt: string | null;
  cadence: string | null;
  loops: SpaceLoopView[];
  people: { id: string; label: string }[];
  sources: string[];
  contextClaims: SpaceContextClaimView[];
  promotionRule: string | null;
  promotingLoopIds: string[];
}

export interface NotASpaceView {
  arcId: string;
  label: string;
  reason: string;
}

export interface LifeProjectView {
  id: string;
  name: string;
  spaceIds: string[];
  spaceLabels: string[];
  emerged: boolean;
}

export interface SpacesPageView {
  counts: Record<SpaceStatus, number>;
  spaces: SpaceView[];
  notSpaces: NotASpaceView[];
  lifeProjects: LifeProjectView[];
}

/** What a gesture hands back: the `mutations` row it wrote (§14.1 rule 1). */
export interface MutationReceiptView {
  mutationId: string;
  actor: string;
  targetKind: string;
  targetId: string;
  field: string | null;
}

// ---------------------------------------------------------------------------
// Reads the store does not already own
// ---------------------------------------------------------------------------

interface ArcChrome {
  labelSource: "model" | "user" | null;
  sources: string[];
}

/**
 * `label_source` and `source_ids` are the two columns `SpaceRow` does not
 * carry, and both are presentation the card needs. One query for the page
 * rather than a store function that would exist only for these two fields.
 */
function readArcChrome(): Map<string, ArcChrome> {
  const rows = getDb()
    .prepare(`SELECT id, label_source, source_ids FROM arcs WHERE promoted = 1`)
    .all() as Record<string, unknown>[];
  const out = new Map<string, ArcChrome>();
  for (const r of rows) {
    const source = text(r.label_source);
    out.set(String(r.id), {
      labelSource: source === "user" ? "user" : source === null ? null : "model",
      sources: jsonArray(r.source_ids),
    });
  }
  return out;
}

interface ArcLoops {
  loops: SpaceLoopView[];
  /** Owners and counterparties, in loop order — the people half of the card. */
  partyIds: string[];
}

/**
 * The loops of every visible space, one query. `readPromotionInput` reads loops
 * too, but for the RULES: it drops `intent` and never joins the owner's label,
 * and the card renders both.
 */
function readArcLoops(arcIds: readonly string[], self: string | null): Map<string, ArcLoops> {
  const out = new Map<string, ArcLoops>();
  if (arcIds.length === 0) return out;
  const rows = getDb()
    .prepare(
      `SELECT l.arc_id AS arc_id, l.id AS id, l.intent AS intent, l.state AS state,
              l.due_utc AS due_utc, l.owner_id AS owner_id, l.counterparty_id AS counterparty_id,
              e.canonical AS owner_label
         FROM loops l LEFT JOIN entities e ON e.id = l.owner_id
        WHERE l.arc_id IN (${marks(arcIds.length)})
        ORDER BY l.due_utc IS NULL, l.due_utc, l.id`,
    )
    .all(...arcIds) as Record<string, unknown>[];

  for (const r of rows) {
    const arcId = String(r.arc_id);
    const entry = out.get(arcId) ?? { loops: [], partyIds: [] };
    const ownerId = text(r.owner_id);
    const ownerIsSelf = self !== null && ownerId === self;
    entry.loops.push({
      id: String(r.id),
      intent: text(r.intent) ?? "",
      state: text(r.state) ?? "unknown",
      dueAt: text(r.due_utc),
      ownerLabel: text(r.owner_label) ?? (ownerIsSelf ? "you" : "unassigned"),
      ownerIsSelf,
    });
    for (const id of [ownerId, text(r.counterparty_id)]) {
      if (id !== null && !entry.partyIds.includes(id)) entry.partyIds.push(id);
    }
    out.set(arcId, entry);
  }
  return out;
}

/** Canonical labels for the ids the page mentions. One query, people only. */
function readPeople(ids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = getDb()
    .prepare(`SELECT id, canonical FROM entities WHERE type = 'person' AND id IN (${marks(ids.length)})`)
    .all(...ids) as Record<string, unknown>[];
  for (const r of rows) out.set(String(r.id), text(r.canonical) ?? String(r.id));
  return out;
}

/**
 * The claims that are context FOR THIS SPACE, computed now (§14.6). There is no
 * store function that reads claims by subject — `claims/store.ts` has
 * `activeClaims()`, which materialises the whole table — so the query lives
 * here, over the `claims_active` VIEW rather than `claim_versions`, so a
 * superseded claim can never be shown as current.
 */
function readContextClaims(anchorIds: readonly string[]): SpaceContextClaimView[] {
  if (anchorIds.length === 0) return [];
  const rows = getDb()
    .prepare(
      `SELECT id, kind, text, predicate, confidence
         FROM claims_active
        WHERE subject_id IN (${marks(anchorIds.length)})
        ORDER BY CASE WHEN kind = ? THEN 0 ELSE 1 END, stated_at DESC, id
        LIMIT ?`,
    )
    .all(...anchorIds, WEIGHTED_CLAIM_KIND, CONTEXT_CLAIM_LIMIT) as Record<string, unknown>[];
  return rows.map((r) => {
    const kind = text(r.kind) ?? "";
    const confidence = r.confidence === null || r.confidence === undefined ? null : Number(r.confidence);
    return {
      claimId: String(r.id),
      kind,
      text: text(r.text) ?? text(r.predicate) ?? "",
      confidence: confidence !== null && Number.isFinite(confidence) ? confidence : null,
      weighted: kind === WEIGHTED_CLAIM_KIND,
    };
  });
}

/**
 * §14.0b — an arc with evidence on a session that is still open is LIVE OUTPUT,
 * and the surface renders it as provisional rather than as settled fact.
 */
function readProvisionalArcIds(): Set<string> {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT ae.arc_id AS arc_id
         FROM arc_episodes ae
         JOIN episode_sessions es ON es.episode_id = ae.episode_id
         JOIN sessions s ON s.id = es.session_id
        WHERE s.status = 'open'`,
    )
    .all() as Record<string, unknown>[];
  return new Set(rows.map((r) => String(r.arc_id)));
}

/** Labels for arbitrary arc ids — what a life project lists its spaces by. */
function readArcLabels(ids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = getDb()
    .prepare(`SELECT id, label, user_label FROM arcs WHERE id IN (${marks(ids.length)})`)
    .all(...ids) as Record<string, unknown>[];
  for (const r of rows) {
    const id = String(r.id);
    out.set(id, text(r.user_label) ?? text(r.label) ?? id);
  }
  return out;
}

function arcExists(id: string): boolean {
  return (
    (getDb().prepare(`SELECT 1 AS one FROM arcs WHERE id = ?`).get(id) as { one: number } | undefined) !==
    undefined
  );
}

// ---------------------------------------------------------------------------
// Composition — the card's own lines
// ---------------------------------------------------------------------------

const BAR_CELLS = 5;
const DAY_MS = 86_400_000;

/**
 * §14.6's strip: `▓▓▓░░ 3 of 7`, `⏳ 31 days`. Counted facts only — loops that
 * closed out of loops that exist, or the days left on a dated space — and null
 * when neither was counted, because "no signal recorded yet" is the honest
 * answer and the surface already knows how to render it.
 */
function signalStrip(loops: readonly SpaceLoopView[], endsAt: string | null, now: number): string | null {
  if (loops.length > 0) {
    const settled = loops.filter((l) => l.state !== "open" && l.state !== "latent").length;
    const filled = Math.round((settled / loops.length) * BAR_CELLS);
    const bar = "▓".repeat(filled) + "░".repeat(BAR_CELLS - filled);
    const next = loops.find((l) => l.state === "open" && l.dueAt !== null);
    const due = next?.dueAt ? ` · next due ${next.dueAt.slice(0, 10)}` : "";
    return `${bar} ${settled} of ${loops.length}${due}`;
  }
  const endsMs = endsAt === null ? NaN : Date.parse(endsAt);
  if (!Number.isFinite(endsMs)) return null;
  const days = Math.round((endsMs - now) / DAY_MS);
  return days >= 0 ? `⏳ ${days} days` : `⏳ ended ${endsAt!.slice(0, 10)}`;
}

/** §14.6's 💤. The wording comes from the status rule that fired, not a guess. */
function dormantNote(verdict: PromotionVerdict, lastEvidenceAt: string | null): string | null {
  switch (verdict.statusReason) {
    case "latent_only":
      return "latent loops only";
    case "loopless_quiet":
      return lastEvidenceAt ? `quiet since ${lastEvidenceAt.slice(0, 10)}` : "quiet";
    case "all_loops_resolved":
      return "every loop resolved";
    default:
      return null;
  }
}

function statusOf(raw: string | null): SpaceStatus {
  return raw === "dormant" || raw === "archived" ? raw : "active";
}

function labelOf(row: { label: string | null; userLabel: string | null }, id: string): string {
  return row.userLabel ?? row.label ?? id;
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export interface SpaceQueryView {
  status: SpaceStatus | null;
  archetype: Archetype | null;
  q: string;
}

function matchesSearch(label: string, q: string): boolean {
  return q === "" || label.toLowerCase().includes(q.toLowerCase());
}

/** Every promoted arc, as §14.6 renders it. Safe on an empty database. */
export function spacesPage(query: SpaceQueryView): SpacesPageView {
  const self = meEntityId();
  const now = Date.now();

  // Archived spaces are still spaces (`promote.ts`: "retrievable, not
  // surfaced"), so the counts — and the archived filter — need all of them.
  const all = readSpaces({ includeArchived: true });

  const counts: Record<SpaceStatus, number> = { active: 0, dormant: 0, archived: 0 };
  for (const row of all) counts[statusOf(row.status)] += 1;

  const rows = all.filter(
    (row) =>
      (query.status === null || statusOf(row.status) === query.status) &&
      (query.archetype === null || row.archetype === query.archetype) &&
      matchesSearch(labelOf(row, row.id), query.q),
  );

  // `◍ still growing` is a corpus-wide fact — older cohorts are still landing —
  // so it is one read for the page rather than one per card.
  const stillGrowing = readCoverage("global", "all").some((r) => r.doneUnits < r.totalUnits);
  const chrome = readArcChrome();
  const provisionalIds = readProvisionalArcIds();
  const byArc = readArcLoops(
    rows.map((r) => r.id),
    self,
  );

  // The verdict is re-derived per space (see the header), and the anchors it
  // read are the same ones the context claims hang off.
  const derived = rows.map((row) => {
    const input = readPromotionInput(row.id, { now, selfEntityId: self });
    return { row, input, verdict: input === null ? null : promotionVerdict(input) };
  });

  const peopleIds: string[] = [];
  for (const { row, input } of derived) {
    for (const id of [...(input?.anchorEntityIds ?? []), ...(byArc.get(row.id)?.partyIds ?? [])]) {
      if (id !== self && !peopleIds.includes(id)) peopleIds.push(id);
    }
  }
  const personLabels = readPeople(peopleIds);

  const spaces = derived.map(({ row, input, verdict }) => toSpaceView(row, input, verdict, {
    chrome: chrome.get(row.id),
    loops: byArc.get(row.id),
    personLabels,
    provisional: provisionalIds.has(row.id),
    stillGrowing,
    self,
    now,
  }));

  return { counts, spaces, notSpaces: readNotSpaces(query.q, self, now), lifeProjects: lifeProjects() };
}

interface SpaceViewParts {
  chrome: ArcChrome | undefined;
  loops: ArcLoops | undefined;
  personLabels: Map<string, string>;
  provisional: boolean;
  stillGrowing: boolean;
  self: string | null;
  now: number;
}

function toSpaceView(
  row: SpaceRow,
  input: ReturnType<typeof readPromotionInput>,
  verdict: PromotionVerdict | null,
  parts: SpaceViewParts,
): SpaceView {
  const loops = parts.loops?.loops ?? [];
  const status = statusOf(row.status);
  const reason = isPromotionRoute(row.promotionReason) ? row.promotionReason : null;

  const people: { id: string; label: string }[] = [];
  for (const id of [...(input?.anchorEntityIds ?? []), ...(parts.loops?.partyIds ?? [])]) {
    if (id === parts.self || people.some((p) => p.id === id)) continue;
    const label = parts.personLabels.get(id);
    if (label !== undefined) people.push({ id, label });
  }

  return {
    id: row.id,
    arcId: row.id,
    label: labelOf(row, row.id),
    // A user label outranks every model label (§14.8), so it also decides what
    // the surface calls the source — the stored column is only asked otherwise.
    labelSource: row.userLabel !== null ? "user" : (parts.chrome?.labelSource ?? null),
    archetype: isArchetype(row.archetype) ? row.archetype : null,
    archetypeSource: (row.archetypeSource as ArchetypeSource | null) ?? null,
    status,
    promotionReason: reason,
    signalStrip: signalStrip(loops, row.endsAt, parts.now),
    pinned: input?.userPinned === true,
    dormantNote: status === "dormant" && verdict ? dormantNote(verdict, row.lastEvidenceAt) : null,
    stillGrowing: parts.stillGrowing,
    provisional: parts.provisional,
    endsAt: row.endsAt,
    cadence: row.cadence,
    loops,
    people,
    sources: parts.chrome?.sources ?? [],
    contextClaims: readContextClaims(input?.anchorEntityIds ?? []),
    promotionRule: reason && verdict ? verdict.evidence[reason].detail : null,
    // The commitment route qualified on the open loops the party gate cleared,
    // so those are the ids behind the promotion. The other three routes are not
    // loop-shaped (an edge, a rhythm, a pin) and name no loop at all.
    promotingLoopIds: reason === "cmt" ? loops.filter((l) => l.state === "open").map((l) => l.id) : [],
  };
}

/**
 * §14.6's "NOT A SPACE": an arc that never qualified, browsable, with the
 * reason it did not. The reason is the route evidence verbatim — the same
 * sentences `[ why a space? ]` renders for the ones that did qualify.
 */
function readNotSpaces(q: string, self: string | null, now: number): NotASpaceView[] {
  const rows = getDb()
    .prepare(
      `SELECT id, label, user_label FROM arcs
        WHERE promoted = 0 ORDER BY last_evidence_at DESC, id LIMIT ?`,
    )
    .all(NOT_A_SPACE_LIMIT) as Record<string, unknown>[];

  const out: NotASpaceView[] = [];
  for (const r of rows) {
    const arcId = String(r.id);
    const label = text(r.user_label) ?? text(r.label) ?? arcId;
    if (!matchesSearch(label, q)) continue;
    const input = readPromotionInput(arcId, { now, selfEntityId: self });
    const verdict = input === null ? null : promotionVerdict(input);
    const reason =
      verdict === null
        ? "no promotion input"
        : verdict.party.blocked
          ? "no loop involves you — this belongs on their People record"
          : `${verdict.evidence.cmt.detail} · ${verdict.evidence.ref.detail}`;
    out.push({ arcId, label, reason });
  }
  return out;
}

/**
 * A life project LINKS spaces, it does not contain them (item 3.9). `emerged`
 * is `goals.emerged_from_json` being present — `readGoals()` drops the column,
 * and "emerged and confirmed, or the user's" is exactly that distinction.
 */
export function lifeProjects(): LifeProjectView[] {
  const goals = readGoals();
  if (goals.length === 0) return [];
  const emerged = new Set(
    (
      getDb()
        .prepare(`SELECT id FROM goals WHERE emerged_from_json IS NOT NULL`)
        .all() as Record<string, unknown>[]
    ).map((r) => String(r.id)),
  );
  const labels = readArcLabels(goals.flatMap((g) => g.spaceIds));
  return goals.map((goal) => ({
    id: goal.id,
    name: goal.name,
    spaceIds: goal.spaceIds,
    spaceLabels: goal.spaceIds.map((id) => labels.get(id) ?? id),
    emerged: emerged.has(goal.id),
  }));
}

// ---------------------------------------------------------------------------
// Gestures — every one of them writes a `mutations` row as `user`
// ---------------------------------------------------------------------------

function lastMutationRowid(): number {
  const row = getDb().prepare(`SELECT MAX(rowid) AS rowid FROM mutations`).get() as
    | { rowid: number | null }
    | undefined;
  return Number(row?.rowid ?? 0);
}

/**
 * The receipt for a gesture. The store functions write the `mutations` row
 * themselves — that is the point of routing writes through them — so this reads
 * back the row they wrote rather than logging a second one for the same change.
 *
 * A gesture that changed nothing still owes the surface a receipt (§14.1 rule
 * 1: the receipt is rendered, not swallowed), so the idempotent case writes its
 * own row with `old === new`, which reverse-replays to nothing.
 */
function receiptSince(
  sinceRowid: number,
  targetId: string,
  field: string,
  unchanged: { value: unknown; reason: string },
): MutationReceiptView {
  const row = getDb()
    .prepare(
      `SELECT id FROM mutations
        WHERE rowid > ? AND target_kind = ? AND target_id = ?
        ORDER BY CASE WHEN field = ? THEN 0 ELSE 1 END, rowid DESC LIMIT 1`,
    )
    .get(sinceRowid, TARGET_KIND, targetId, field) as { id: string } | undefined;

  const mutationId =
    row?.id ??
    logMutation({
      actor: USER_ACTOR,
      targetKind: TARGET_KIND,
      targetId,
      field,
      oldValue: unchanged.value,
      newValue: unchanged.value,
      reason: unchanged.reason,
    });
  return { mutationId, actor: USER_ACTOR, targetKind: TARGET_KIND, targetId, field };
}

// ---------------------------------------------------------------------------
// The route handler
// ---------------------------------------------------------------------------

/** Handle a spaces request. Returns true when this module owns the path. */
export async function handleSpacesRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (path !== "/api/spaces" && !path.startsWith("/api/spaces/") && path !== "/api/goals") return false;

  // ---- GET /api/spaces?status=&archetype=&q= ------------------------------
  if (method === "GET" && path === "/api/spaces") {
    const status = url.searchParams.get("status");
    const archetype = url.searchParams.get("archetype");
    if (status !== null && !(SPACE_STATUSES as readonly string[]).includes(status)) {
      sendJson(res, 400, { error: `status must be one of ${SPACE_STATUSES.join(", ")}` });
      return true;
    }
    if (archetype !== null && !isArchetype(archetype)) {
      sendJson(res, 400, { error: "archetype is not one of the eight" });
      return true;
    }
    sendJson(res, 200, {
      ...spacesPage({
        status: (status as SpaceStatus | null) ?? null,
        archetype: archetype ?? null,
        q: url.searchParams.get("q") ?? "",
      }),
    });
    return true;
  }

  // ---- GET /api/goals -----------------------------------------------------
  if (method === "GET" && path === "/api/goals") {
    sendJson(res, 200, lifeProjects());
    return true;
  }

  // Every write below is one arc, and `actor` in the body is never trusted: a
  // surface gesture may only ever write as `user` (§14.1).
  const gesture = path.match(/^\/api\/spaces\/([^/]+)\/(archetype|relabel|pin|archive)$/);
  if (method === "POST" && gesture) {
    const id = decodeURIComponent(gesture[1]!);
    const kind = gesture[2]!;
    const body = await readJsonBody(req);
    if (body === undefined) {
      sendJson(res, 400, { error: "invalid json body" });
      return true;
    }
    if (!arcExists(id)) {
      sendJson(res, 404, { error: "no space with that id" });
      return true;
    }
    const since = lastMutationRowid();

    // ---- POST /api/spaces/:id/archetype { archetype } ---------------------
    if (kind === "archetype") {
      const next = body.archetype;
      if (!isArchetype(next)) {
        sendJson(res, 400, { error: "archetype is not one of the eight" });
        return true;
      }
      // §14.8: a user archetype outranks the model's, and `setArchetype`
      // records the transition WITH its reason — that record is the receipt.
      const write = setArchetype(id, next, "user", "user set the archetype on the Spaces surface", {
        actor: USER_ACTOR,
      });
      sendJson(
        res,
        200,
        receiptSince(since, id, "archetype", {
          value: write.archetype,
          reason: "archetype unchanged",
        }),
      );
      return true;
    }

    // ---- POST /api/spaces/:id/relabel { label } ---------------------------
    if (kind === "relabel") {
      const label = body.label;
      if (typeof label !== "string") {
        sendJson(res, 400, { error: "label (string) required" });
        return true;
      }
      // An empty label is not a name — it hands the space back to the model's,
      // which is what a null `user_label` means (§14.8).
      const trimmed = label.trim();
      setUserLabel(id, trimmed === "" ? null : trimmed, { actor: USER_ACTOR });
      sendJson(
        res,
        200,
        receiptSince(since, id, "user_label", { value: trimmed, reason: "label unchanged" }),
      );
      return true;
    }

    // ---- POST /api/spaces/:id/pin { pinned } ------------------------------
    if (kind === "pin") {
      const pinned = body.pinned;
      if (typeof pinned !== "boolean") {
        sendJson(res, 400, { error: "pinned (boolean) required" });
        return true;
      }
      // 📌 is a promotion ROUTE, so the pin re-derives promotion in the same
      // call. Both writes carry `user`: the whole gesture is one undoable unit.
      if (pinned) pinArc(id, { actor: USER_ACTOR });
      else unpinArc(id, { actor: USER_ACTOR });
      sendJson(
        res,
        200,
        receiptSince(since, id, "user_pinned", { value: pinned ? 1 : 0, reason: "pin unchanged" }),
      );
      return true;
    }

    // ---- POST /api/spaces/:id/archive { archived } ------------------------
    const archived = body.archived;
    if (typeof archived !== "boolean") {
      sendJson(res, 400, { error: "archived (boolean) required" });
      return true;
    }
    if (archived) {
      // `arcs.status` is derived from member loops on every reconcile, and
      // nothing in `promote-store.ts` writes it on its own — the sweep only
      // ever writes the DERIVED value. A human archiving a space is the one
      // override, so the UPDATE lives here, and it is one field, logged.
      const row = getDb().prepare(`SELECT status FROM arcs WHERE id = ?`).get(id) as
        | { status: string | null }
        | undefined;
      const before = row?.status ?? null;
      if (before !== "archived") {
        getDb()
          .prepare(
            `UPDATE arcs SET status = 'archived',
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
          )
          .run(id);
        logMutation({
          actor: USER_ACTOR,
          targetKind: TARGET_KIND,
          targetId: id,
          field: "status",
          oldValue: before,
          newValue: "archived",
          reason: "user archived this space",
        });
      }
    } else {
      // Un-archiving is not a second override: it hands the field back to the
      // rule, by re-deriving the verdict and applying it.
      const input = readPromotionInput(id);
      if (input) applyPromotionVerdict(promotionVerdict(input), { actor: USER_ACTOR });
    }
    sendJson(
      res,
      200,
      receiptSince(since, id, "status", {
        value: archived ? "archived" : null,
        reason: archived ? "already archived" : "status already derived",
      }),
    );
    return true;
  }

  sendJson(res, 404, { error: "unknown spaces route" });
  return true;
}
