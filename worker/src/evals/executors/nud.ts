// ===========================================================================
// [CODE] NUD — nudges and the surface router (GoldenEvals V6 P1 §5.13
// NUD-01..09; Build S4.3). Deterministic, ZERO model calls.
//
// Each case seeds its own world — the spaces, the Settings › Assist rows the
// case names, a screen event at the fixture's presence time, the live pass's
// prepared_action rows (which carry the nudge KIND) and the executor-lite
// artifacts they produced — and then drives the REAL surfaces/router.ts:
//
//   NUD-01  at the Mac: card ON TOP of panel · shelf · space · timeline
//   NUD-02  away: the identical set minus the card (`router_withheld = 0`)
//   NUD-03  the 60-second auto-close costs a glance and loses nothing; the
//           unread counter carries it and the artifact never pops again
//   NUD-04  three artifacts on one space inside the window → ONE card, one
//           line each: "Goa trip: villa comparison · Karan replied · fare
//           dropped"
//   NUD-05  the decay order, newest first inside a kind
//   NUD-06  housekeeping is not a nudge: Recent understanding, nothing else
//   NUD-07  two "Not now" taps rank that kind down; the third still reaches
//           every durable surface and takes the card once nothing outranks it
//   NUD-08  a blocked kind never shows, is listed in Settings › Assist, and
//           one removal restores it
//   NUD-09  a card naming the wrong goal is caught and counted — the one
//           real failure, and the precision gate's input
//
// Every case removes its own rows afterwards.
// ===========================================================================

import { createArtifact } from "../../assist/artifacts.js";
import { PREPARED_ACTION_KIND } from "../../brain/live.js";
import { getDb } from "../../db/connection.js";
import { appStateDelete, appStateSet } from "../../db/ingest.js";
import {
  BLOCKED_KINDS_KEY,
  CARD_DURATION_S_KEY,
  INTENT_FLOOR_KEY,
  MERGE_WINDOW_S_KEY,
  assistP1Settings,
} from "../../settings/p1-settings.js";
import {
  DISMISS_KEY_PREFIX,
  autoCloseCard,
  markCardShown,
  notNowCard,
  nudgeView,
  routeNow,
  unreadCount,
  withheldCount,
  wrongGoalCards,
  type RoutePlan,
  type RoutedItemPlan,
} from "../../surfaces/router.js";
import type { Executor, ExecutorResult, Violation } from "../runner.js";

/** Sat 2026-09-05 16:10 IST — the same [NOW] the LIV and EXE cases use. */
export const NUD_NOW_ISO = "2026-09-05T10:40:00.000Z";

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function list(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(rec) : [];
}
function str(v: unknown, fallback: string | null = null): string | null {
  return typeof v === "string" && v !== "" ? v : fallback;
}
function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

// ---------------------------------------------------------------------------
// The case world
// ---------------------------------------------------------------------------

export interface NudSeeded {
  spaceIds: string[];
  artifactIds: string[];
  preparedIds: string[];
  eventIds: string[];
  nowMs: number;
}

/** One artifact + the prepared action behind it (which carries the kind). */
function seedItem(seeded: NudSeeded, spec: Record<string, unknown>, index: number): string {
  const db = getDb();
  const id = str(spec.id) ?? `art_nud_${index}`;
  const readyMs = Date.parse(str(spec.ready_at) ?? NUD_NOW_ISO);
  const preparedId = `prep_${id}`;
  db.prepare(
    `INSERT INTO deferred_outputs (id, space_id, task_id, kind, payload_json, status, created_by, created_at)
     VALUES (?, ?, NULL, ?, ?, 'deferred', 'live', ?)`,
  ).run(
    preparedId,
    str(spec.space),
    PREPARED_ACTION_KIND,
    JSON.stringify({
      kind: str(spec.kind) ?? "help_now",
      intent: str(spec.intent) ?? "prepared work",
      intent_confidence: num(spec.intent_confidence, 0.9),
    }),
    new Date(readyMs).toISOString(),
  );
  seeded.preparedIds.push(preparedId);
  // createArtifact mints its own id; the fixture's id is the stable handle, so
  // the row is renamed to it (one statement, before anything reads it).
  const { artifact } = createArtifact({
    kind: "comparison",
    title: str(spec.line) ?? "prepared work",
    summary: str(spec.intent),
    body: { body: str(spec.peek) ?? "" },
    intent: str(spec.intent),
    spaceId: str(spec.space),
    topicKey: `prepared:${preparedId}`,
    contentKey: `nud:${id}`,
    producer: "executor",
    nowMs: readyMs,
  });
  db.prepare(`UPDATE artifacts SET id = ? WHERE id = ?`).run(id, artifact.id);
  db.prepare(`UPDATE decisions SET target_id = ? WHERE target_kind = 'artifact' AND target_id = ?`).run(id, artifact.id);
  seeded.artifactIds.push(id);
  return id;
}

export function seedNud(setup: Record<string, unknown>): NudSeeded {
  const db = getDb();
  const nowMs = Date.parse(str(setup.now) ?? NUD_NOW_ISO);
  const seeded: NudSeeded = { spaceIds: [], artifactIds: [], preparedIds: [], eventIds: [], nowMs };

  for (const sp of list(setup.spaces)) {
    const id = str(sp.id) ?? "sp_nud";
    db.prepare(`INSERT INTO spaces (id, label, goal, status, created_by, updated_at) VALUES (?, ?, ?, 'active', 'eval', ?)`)
      .run(id, str(sp.label) ?? id, str(sp.goal), new Date(nowMs).toISOString());
    seeded.spaceIds.push(id);
  }

  // Presence: the last screen event. Absent = the user is not at the Mac.
  const screenAt = str(setup.last_screen_event);
  if (screenAt) {
    db.prepare(`INSERT OR IGNORE INTO sources (id, type, name) VALUES ('screen', 'screen', 'Screen')`).run();
    const evId = `ev_nud_screen`;
    db.prepare(
      `INSERT INTO events (id, source_id, source_type, ts, kind, text) VALUES (?, 'screen', 'screen', ?, 'ax', 'window')`,
    ).run(evId, screenAt);
    seeded.eventIds.push(evId);
  }

  // Settings › Assist, exactly the rows the case names.
  if (setup.merge_window_s !== undefined) appStateSet(MERGE_WINDOW_S_KEY, String(num(setup.merge_window_s, 120)));
  if (setup.card_duration_s !== undefined) appStateSet(CARD_DURATION_S_KEY, String(num(setup.card_duration_s, 60)));
  if (setup.intent_floor !== undefined) appStateSet(INTENT_FLOOR_KEY, String(num(setup.intent_floor, 0.6)));
  if (setup.blocked_kinds !== undefined) appStateSet(BLOCKED_KINDS_KEY, JSON.stringify(strs(setup.blocked_kinds)));

  // NUD-07's history: the cards the user already said "Not now" to.
  list(setup.dismiss).forEach((spec, i) => {
    const id = seedItem(seeded, spec, 1000 + i);
    notNowCard(id, nowMs);
  });

  list(setup.items).forEach((spec, i) => seedItem(seeded, spec, i));
  return seeded;
}

export function cleanupNud(s: NudSeeded): void {
  const db = getDb();
  db.transaction(() => {
    for (const id of s.artifactIds) {
      db.prepare(`DELETE FROM artifact_signals WHERE artifact_id = ?`).run(id);
      db.prepare(`DELETE FROM questions WHERE target_kind = 'artifact' AND target_id = ?`).run(id);
      db.prepare(`DELETE FROM decisions WHERE target_kind = 'artifact' AND target_id = ?`).run(id);
      db.prepare(`DELETE FROM artifacts WHERE id = ?`).run(id);
    }
    db.prepare(`DELETE FROM artifacts WHERE producer = 'executor'`).run();
    for (const id of s.preparedIds) db.prepare(`DELETE FROM deferred_outputs WHERE id = ?`).run(id);
    for (const id of s.eventIds) db.prepare(`DELETE FROM events WHERE id = ?`).run(id);
    for (const id of s.spaceIds) db.prepare(`DELETE FROM spaces WHERE id = ?`).run(id);
  })();
  for (const key of [MERGE_WINDOW_S_KEY, CARD_DURATION_S_KEY, INTENT_FLOOR_KEY, BLOCKED_KINDS_KEY]) appStateDelete(key);
  for (const kind of ["help_now", "needs_you", "something_moved", "done_for_you", "done_in_advance", "understanding"]) {
    appStateDelete(`${DISMISS_KEY_PREFIX}${kind}`);
  }
}

// ---------------------------------------------------------------------------
// Run + assert
// ---------------------------------------------------------------------------

const surfacesOf = (p: RoutedItemPlan | undefined): string[] => (p ? [...p.surfaces] : []);
const idsOf = (plan: RoutePlan): string[] => plan.items.map((p) => p.id);
const byId = (plan: RoutePlan, id: string): RoutedItemPlan | undefined => plan.items.find((p) => p.id === id);

export interface NudRun {
  seeded: NudSeeded;
  plan: RoutePlan;
  awayPlan: RoutePlan;
  view: ReturnType<typeof nudgeView>;
  /** Case-specific extras (the second route of NUD-03 / NUD-08, …). */
  extra: Record<string, unknown>;
  wrongGoal: number;
}

function assertCase(id: string, run: NudRun, expected: Record<string, unknown>): Violation[] {
  const v: Violation[] = [];
  const plan = run.plan;
  switch (id) {
    case "NUD-01": {
      if (plan.presence !== "mac_active") v.push({ label: "card-instead-of-panel", note: `presence ${plan.presence}` });
      const want = strs(expected.surfaces);
      const got = surfacesOf(plan.current ?? undefined);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        v.push({ label: "card-instead-of-panel", note: `surfaces ${JSON.stringify(got)}, expected ${JSON.stringify(want)}` });
      }
      if (plan.current?.id !== str(expected.current_card)) {
        v.push({ label: "second-card", note: `card is ${plan.current?.id ?? "none"}` });
      }
      if (plan.items.filter((p) => p.card !== null).length !== 1) {
        v.push({ label: "second-card", note: "more than one card at a time" });
      }
      if (plan.current?.card?.title !== str(expected.card_title)) {
        v.push({ label: "card-instead-of-panel", note: `title ${plan.current?.card?.title ?? "none"}` });
      }
      break;
    }
    case "NUD-02": {
      if (plan.presence !== "away") v.push({ label: "held-back", note: `presence ${plan.presence}` });
      const got = surfacesOf(plan.items[0]);
      const want = strs(expected.surfaces);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        v.push({ label: "held-back", note: `surfaces ${JSON.stringify(got)}, expected ${JSON.stringify(want)}` });
      }
      if (plan.current !== null) v.push({ label: "quiet-hours", note: "a card while the user is away" });
      // The whole gate: at the Mac and away differ by the card and nothing else.
      const atMac = run.extra.at_mac as RoutePlan;
      if (withheldCount(atMac, plan) !== 0) v.push({ label: "held-back", note: "a durable surface was lost to presence" });
      for (const item of plan.items) {
        const other = byId(atMac, item.id);
        const minusCard = other ? other.surfaces.filter((s) => s !== "card") : [];
        if (JSON.stringify(minusCard) !== JSON.stringify(item.surfaces)) {
          v.push({ label: "quiet-hours", note: `${item.id} differs from the Mac routing by more than the card` });
        }
      }
      break;
    }
    case "NUD-03": {
      const shownAt = num(run.extra.shown_at_ms, 0);
      const closeAt = num(run.extra.auto_close_at_ms, 0);
      if ((closeAt - shownAt) / 1000 !== num(expected.auto_close_after_s, 60)) {
        v.push({ label: "lost-on-close", note: `auto-close after ${(closeAt - shownAt) / 1000}s` });
      }
      if (num(run.extra.unread_after_close, -1) !== num(expected.unread_after_close, 1)) {
        v.push({ label: "lost-on-close", note: `unread ${run.extra.unread_after_close}` });
      }
      if (str(run.extra.status_after_close) !== str(expected.status_after_close)) {
        v.push({ label: "lost-on-close", note: `status ${run.extra.status_after_close}` });
      }
      const after = run.extra.after_close as RoutePlan;
      if (after.items.some((p) => p.card !== null)) v.push({ label: "re-pop", note: "a second card after the auto-close" });
      const rows = getDb().prepare(`SELECT COUNT(*) AS n FROM artifacts WHERE status IN ('new','seen')`).get() as { n: number };
      if (rows.n < 1) v.push({ label: "lost-on-close", note: "the artifact is gone from the store" });
      break;
    }
    case "NUD-04": {
      const cards = plan.items.filter((p) => p.card !== null);
      if (cards.length !== num(expected.cards, 1)) v.push({ label: "three-cards", note: `${cards.length} cards` });
      if (plan.items.length !== 1) v.push({ label: "three-cards", note: `${plan.items.length} routed groups` });
      const card = cards[0]?.card;
      if (card?.title !== str(expected.card_title)) v.push({ label: "three-cards", note: `title ${card?.title ?? "none"}` });
      if (card?.line !== str(expected.card_line)) v.push({ label: "three-cards", note: `line ${JSON.stringify(card?.line)}` });
      const merged = cards[0]?.mergedWith ?? [];
      if (JSON.stringify(merged) !== JSON.stringify(strs(expected.merged_with))) {
        v.push({ label: "merged-across-spaces", note: `merged ${JSON.stringify(merged)}` });
      }
      break;
    }
    case "NUD-05": {
      const want = strs(expected.order);
      if (JSON.stringify(idsOf(plan)) !== JSON.stringify(want)) {
        v.push({ label: "newest-first-across-kinds", note: `order ${JSON.stringify(idsOf(plan))}` });
      }
      if (plan.current?.id !== str(expected.current_card)) {
        v.push({ label: "newest-first-across-kinds", note: `card is ${plan.current?.id ?? "none"}` });
      }
      for (const item of plan.items) {
        for (const surface of ["panel", "shelf", "space", "timeline"]) {
          if (!item.surfaces.includes(surface as never)) {
            v.push({ label: "queued-behind-forever", note: `${item.id} lost ${surface} while it waits` });
          }
        }
      }
      break;
    }
    case "NUD-06": {
      if (plan.items.some((p) => p.card !== null)) v.push({ label: "housekeeping-card", note: "a card for bookkeeping" });
      const want = strs(expected.surfaces_each);
      for (const item of plan.items) {
        if (JSON.stringify([...item.surfaces]) !== JSON.stringify(want)) {
          v.push({ label: "housekeeping-on-the-panel", note: `${item.id} → ${JSON.stringify(item.surfaces)}` });
        }
      }
      break;
    }
    case "NUD-07": {
      const dismissals = num(run.extra.dismissals_something_moved, 0);
      if (dismissals !== num(expected.dismissals_something_moved, 2)) {
        v.push({ label: "dismissal-ignored", note: `${dismissals} dismissals recorded` });
      }
      const want = strs(expected.order);
      if (JSON.stringify(idsOf(plan)) !== JSON.stringify(want)) {
        v.push({ label: "dismissal-ignored", note: `order ${JSON.stringify(idsOf(plan))}` });
      }
      if (plan.current?.id !== str(expected.current_card)) {
        v.push({ label: "dismissal-ignored", note: `card is ${plan.current?.id ?? "none"}` });
      }
      const third = byId(plan, "art_fare_3");
      if (JSON.stringify(surfacesOf(third)) !== JSON.stringify(strs(expected.third_surfaces))) {
        v.push({ label: "dismissal-mutes", note: `the third fare alert reached ${JSON.stringify(surfacesOf(third))}` });
      }
      break;
    }
    case "NUD-08": {
      if (plan.items.some((p) => p.card !== null)) v.push({ label: "blocked-still-shows", note: "a card for a blocked kind" });
      const blocked = plan.items[0];
      if (JSON.stringify(surfacesOf(blocked)) !== JSON.stringify(strs(expected.blocked_surfaces))) {
        v.push({ label: "blocked-is-deleted", note: `blocked → ${JSON.stringify(surfacesOf(blocked))}` });
      }
      if (blocked?.surfaces.includes("panel") || blocked?.surfaces.includes("shelf")) {
        v.push({ label: "blocked-still-shows", note: "a blocked kind on the panel or the shelf" });
      }
      const inSettings = strs(run.extra.blocked_in_settings);
      if (JSON.stringify(inSettings) !== JSON.stringify(strs(expected.visible_in_settings))) {
        v.push({ label: "block-is-permanent", note: `Settings › Assist lists ${JSON.stringify(inSettings)}` });
      }
      const after = run.extra.after_unblock as RoutePlan;
      if (after.current?.id !== str(expected.after_unblock_card)) {
        v.push({ label: "block-is-permanent", note: `after unblocking the card is ${after.current?.id ?? "none"}` });
      }
      break;
    }
    case "NUD-09": {
      if (num(run.extra.wrong_goal_cards, 0) !== num(expected.wrong_goal_cards, 1)) {
        v.push({ label: "precision-not-counted", note: `${run.extra.wrong_goal_cards} wrong-goal cards counted` });
      }
      // The router's OWN card must name the artifact's own space.
      if (plan.current?.card?.spaceId !== plan.current?.spaceId) {
        v.push({ label: "wrong-goal-card", note: `card names ${plan.current?.card?.spaceId}, item is ${plan.current?.spaceId}` });
      }
      if (plan.current?.card?.title !== str(expected.honest_card_title)) {
        v.push({ label: "wrong-goal-card", note: `title ${plan.current?.card?.title ?? "none"}` });
      }
      if (run.wrongGoal !== 0) v.push({ label: "wrong-goal-card", note: "the honest routing produced a wrong-goal card" });
      break;
    }
    default:
      v.push({ label: "unknown-case", note: `no NUD assertions for ${id}` });
  }
  return v;
}

export async function runNudCase(id: string, setup: Record<string, unknown>): Promise<NudRun> {
  const seeded = seedNud(setup);
  const nowMs = seeded.nowMs;
  const extra: Record<string, unknown> = {};

  // Every case routes the real pending set once against the real world, and
  // once more with presence forced the other way — the withheld gate is the
  // difference between the two.
  const plan = routeNow(nowMs);
  const awayPlan = routeNow(nowMs, { macActive: false });
  extra.at_mac = routeNow(nowMs, { macActive: true });

  if (id === "NUD-03" && plan.current) {
    markCardShown(plan.current, nowMs);
    extra.shown_at_ms = nowMs;
    const closeAt = plan.current.card!.autoCloseAtMs;
    extra.auto_close_at_ms = closeAt;
    extra.unread_after_close = autoCloseCard(plan.current.id, closeAt).unread;
    const row = getDb().prepare(`SELECT status FROM artifacts WHERE id = ?`).get(plan.current.id) as { status: string };
    extra.status_after_close = row.status;
    extra.after_close = routeNow(closeAt + 1_000);
  }

  if (id === "NUD-07") {
    extra.dismissals_something_moved = list(setup.dismiss).length;
  }

  if (id === "NUD-08") {
    extra.blocked_in_settings = assistP1Settings().blocked_kinds;
    appStateSet(BLOCKED_KINDS_KEY, JSON.stringify([]));
    extra.after_unblock = routeNow(nowMs);
  }

  let wrongGoal = wrongGoalCards(plan).length;
  if (id === "NUD-09") {
    // The honest routing names the right space; the case's own card names
    // sp_falcon, which is what the precision check has to catch.
    const named = str(list(setup.items)[0]?.card_names_space);
    const forged: RoutePlan = {
      ...plan,
      items: plan.items.map((p) => ({ ...p, card: p.card ? { ...p.card, spaceId: named } : null })),
    };
    extra.wrong_goal_cards = wrongGoalCards(forged).length;
  }

  return { seeded, plan, awayPlan, view: nudgeView(nowMs), extra, wrongGoal };
}

export const nudExecutor: Executor = async ({ fixture }) => {
  const setup = rec(fixture.setup);
  if (!Array.isArray(setup.items)) {
    return { ok: false, output: null, pending: `${fixture.id}: NUD fixtures need a structured setup.items block` };
  }
  const run = await runNudCase(fixture.id, setup);
  try {
    const violations = assertCase(fixture.id, run, rec(fixture.expected));
    const plan = run.plan;
    const withheld = plan.withheld + withheldCount(run.extra.at_mac as RoutePlan, run.awayPlan);
    const caught = num(run.extra.wrong_goal_cards, 0);
    const result: ExecutorResult = {
      ok: violations.length === 0,
      output: {
        presence: plan.presence,
        current_card: plan.current?.id ?? null,
        card: plan.current?.card ?? null,
        order: plan.items.map((p) => p.id),
        routed: plan.items.map((p) => ({
          id: p.id,
          kind: p.kind,
          surfaces: p.surfaces,
          rank: p.rank,
          merged_with: p.mergedWith,
          reason: p.reason,
        })),
        away: run.awayPlan.items.map((p) => ({ id: p.id, surfaces: p.surfaces })),
        unread: unreadCount(),
        extra: run.extra,
      },
      violations,
      metrics: {
        model_calls: 0,
        cards: plan.items.filter((p) => p.card !== null).length,
        routed_items: plan.items.length,
        merged_items: plan.items.reduce((n, p) => n + p.mergedWith.length, 0),
        router_withheld: withheld,
        // The router's own cards always name the item's own space; the count
        // below is what the precision check CAUGHT in NUD-09's forged card.
        nudge_precision_violation: run.wrongGoal,
        wrong_goal_cards_caught: caught,
        unread: unreadCount(),
      },
      gateObservations: [{ gateId: "router_withheld", passed: withheld === 0, counted: true }],
      notes: [
        "the real surfaces/router.ts against a seeded world: presence off the last screen event, the kind off the prepared action, the window and the blocked list off Settings › Assist. Zero model calls.",
      ],
    };
    return result;
  } finally {
    cleanupNud(run.seeded);
  }
};
