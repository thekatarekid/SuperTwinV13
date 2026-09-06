// ===========================================================================
// [CODE] The "Who I am" card — V6 P1 S5.4 (Product_V6 §11.7, Product_V6_Phase1
// §3.5 "fills from processing over the first hour. No form").
//
// Built by PROCESSING, read here. Every line is a claim about the self entity
// (or a person the record has placed in a circle) with its evidence and
// confidence; the user edits any line through the corrections pipeline on the
// underlying claim — there is no form and no free-text profile table.
//
//   basics     name · home · hometown · addresses · contacts · handles ·
//              birthday · anniversaries  (fact claims, keyword-routed)
//   life       occupation · education · partner · family · friends ·
//              coworkers (claims + the people the circles hold)
//   narrative  the twin's narrative claims (kind narrative), newest first
//   traits     preferences · interests · likes · dislikes · habits ·
//              patterns · values · workflows
//   voice      tone per audience — DM and group registers the record holds
// ===========================================================================

import { getDb } from "../db/connection.js";
import { claimsAbout, type ClaimVersionRow } from "../claims/store.js";
import { SELF_ENTITY_ID } from "../db/migrations/0201_v6_graph.js";
import { listEntities, type Circle } from "../entities/registry.js";

export interface CardLine {
  text: string;
  confidence: number | null;
  evidence: { event_ids: string[]; quote: string }[];
  /** The claim the line reads from — corrections target this. */
  claimKey: string | null;
  kind: string | null;
  statedAt: string | null;
  /** How the line came to be: processing (claims) · circles (people) · tone. */
  source: "processing" | "circles" | "tone";
  editable: boolean;
}

export interface WhoIAmCard {
  selfId: string;
  filledBy: "processing";
  basics: CardLine[];
  life: CardLine[];
  narrative: CardLine[];
  traits: CardLine[];
  voice: CardLine[];
  people: Record<Circle, { id: string; name: string | null }[]>;
  counts: { claims: number; people: number };
  empty: boolean;
  /** Shown while nothing has landed yet. */
  emptyNote: string | null;
}

const BASIC_WORDS = /\b(name|lives? in|lives at|home|hometown|from|address|phone|number|email|handle|@|birthday|born|anniversary|age|pin)\b/i;
const LIFE_WORDS = /\b(work|works|job|occupation|engineer|designer|founder|studied|studies|college|school|degree|company|role|team|partner|wife|husband|girlfriend|boyfriend|family|mother|father|sister|brother)\b/i;
const TRAIT_KINDS = new Set(["preference", "interest", "like", "dislike", "habit", "pattern", "value", "workflow", "behavioral", "recommendation", "belief", "opinion"]);

function line(c: ClaimVersionRow, source: CardLine["source"] = "processing"): CardLine {
  return {
    text: c.text ?? "",
    confidence: c.confidence,
    evidence: c.evidence.map((e) => ({ event_ids: e.event_ids, quote: e.quote })),
    claimKey: c.claimKey,
    kind: c.kind,
    statedAt: c.statedAt,
    source,
    editable: true,
  };
}

export function buildWhoIAm(): WhoIAmCard {
  const db = getDb();
  const claims = claimsAbout(SELF_ENTITY_ID).filter((c) => c.text && c.text.trim() !== "");
  const basics: CardLine[] = [];
  const life: CardLine[] = [];
  const narrative: CardLine[] = [];
  const traits: CardLine[] = [];
  for (const c of claims) {
    const kind = (c.kind ?? "").toLowerCase();
    if (kind === "narrative") narrative.push(line(c));
    else if (TRAIT_KINDS.has(kind)) traits.push(line(c));
    else if (kind === "relationship" || LIFE_WORDS.test(c.text ?? "")) life.push(line(c));
    else if (kind === "fact" && BASIC_WORDS.test(c.text ?? "")) basics.push(line(c));
    else if (kind === "fact") life.push(line(c));
    else traits.push(line(c));
  }
  narrative.sort((a, b) => (b.statedAt ?? "").localeCompare(a.statedAt ?? ""));

  // People by circle — the life section's roster half, from processing's circles.
  const people = {} as WhoIAmCard["people"];
  for (const c of ["partner", "family", "close_friends", "friends", "coworkers", "important_services", "old_batchmates", "acquaintances", "businesses"] as Circle[]) people[c] = [];
  let peopleCount = 0;
  for (const e of listEntities({ type: "person" })) {
    if (e.id === SELF_ENTITY_ID || !e.circle) continue;
    people[e.circle].push({ id: e.id, name: e.canonical });
    peopleCount += 1;
  }
  for (const c of ["partner", "family", "close_friends", "coworkers"] as Circle[]) {
    if (people[c].length === 0) continue;
    life.push({
      text: `${c.replace("_", " ")}: ${people[c].map((p) => p.name ?? p.id).join(", ")}`,
      confidence: null,
      evidence: [],
      claimKey: null,
      kind: "circle",
      statedAt: null,
      source: "circles",
      editable: false,
    });
  }

  // Voice: the registers the record holds, DM and group apart.
  const tones = db
    .prepare(
      `SELECT t.register, t.language_mix, t.emoji_habits, t.person_entity_id, t.stream_id, s.label AS stream_label, e.canonical AS person_name
         FROM tone_profiles t
         LEFT JOIN streams s ON s.id = t.stream_id
         LEFT JOIN entities e ON e.id = t.person_entity_id
        WHERE t.register IS NOT NULL OR t.language_mix IS NOT NULL`,
    )
    .all() as { register: string | null; language_mix: string | null; emoji_habits: string | null; person_entity_id: string | null; stream_id: string | null; stream_label: string | null; person_name: string | null }[];
  const voice: CardLine[] = tones.map((t) => ({
    text: `${t.person_entity_id ? `DM with ${t.person_name ?? "a person"}` : `group ${t.stream_label ?? t.stream_id ?? ""}`}: ${[t.register, t.language_mix, t.emoji_habits].filter(Boolean).join(" · ")}`,
    confidence: null,
    evidence: [],
    claimKey: null,
    kind: "tone",
    statedAt: null,
    source: "tone",
    editable: false,
  }));

  const empty = claims.length === 0 && peopleCount === 0 && voice.length === 0;
  return {
    selfId: SELF_ENTITY_ID,
    filledBy: "processing",
    basics,
    life,
    narrative,
    traits,
    voice,
    people,
    counts: { claims: claims.length, people: peopleCount },
    empty,
    emptyNote: empty ? "Nothing yet — this card fills from processing over the first hour. There is no form." : null,
  };
}
