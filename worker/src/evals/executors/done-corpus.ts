// ===========================================================================
// [CODE] The labelled done-detection corpus behind `loops_done_detection_precision`
// (build item 4.1; arch §12.9, §11.4.3; item 3.8's ≥ 0.95 bar).
//
// §14.2's "done-detection precision < 0.95 fails the build" is a rate over the
// loops a P-DD1 pass CLOSED: of the closes, how many were really done. The Q
// fixture table poses the qualitative cases (`ps` raises a question, the state
// that does not exist is refused) but no fixture measures the precision rate —
// which left the gate at `no data`.
//
// This corpus supplies the labelled population. Every loop carries a gold
// `trulyDone` label, the frozen P-DD1 answer is parsed by the REAL
// `parseDd1Response` against the REAL alias table `packPrompt` minted, and the
// closes are decided by the REAL `applyDd1Answer` — including its §12.9
// evidence checks (timed, cited, after `stated_at`). Nothing below decides a
// close; the product does.
//
// THE MIX, and why the gate can fail:
//
//   12 genuinely-done loops, `dn` citing evidence AFTER the loop was stated —
//      the pipeline must close all twelve, and each close is checked against
//      the label.
//    2 NOT-done loops where the model says `dn` citing evidence from BEFORE
//      the loop was stated — §12.9's "count only evidence occurring AFTER"
//      must decline these. If that check regresses, two wrong closes land and
//      precision reads 12/14 ≈ 0.86 < 0.95: the gate fails.
//    1 `dn` citing no event at all ("never mark done on a guess") and
//    1 `dn` citing an alias that resolves to nothing — both must be declined,
//      and each becomes a wrong close on regression.
//    2 `dr` with valid evidence (dropped, not done — outside the precision
//      denominator by definition), 1 `ps`, 1 `op` — the rest of the call's
//      vocabulary, present so the parse is a real parse.
//
// One observation is emitted per CLOSE_DONE outcome, passed only when the gold
// label agrees — so the gate's pass_rate IS the measured precision, over the
// pipeline's own closes. `donePrecision` (the product's own meter) is computed
// over the same application and asserted equal by the tests.
// ===========================================================================

import { applyDd1Answer, donePrecision, type DoneApplication } from "../../loops/done.js";
import { buildDd1Prompt, parseDd1Response, type Dd1Loop } from "../../prompts/p-dd1.js";
import { packPrompt, type PackEvent } from "../../wire/pack.js";
import type { GateObservation } from "../runner.js";

/** Loops were stated early August; proof evidence lands 10 Aug, pre-stated
 * temptations 20 Jul. Frozen, so the corpus is offline and stable. */
const STATED_AT = "2026-08-01T09:00:00.000Z";
const PROOF_DAY = "2026-08-10";
const BEFORE_DAY = "2026-07-20";

const SELF = "self";
const OTHER = "ent_pranjali";

interface CorpusLoop {
  loopId: string;
  intent: string;
  /** The gold label: was this loop really completed? */
  trulyDone: boolean;
  /** The model's answer code for this loop. */
  code: "dn" | "ps" | "dr" | "op";
  /** Which event the model cites: an event key, "-" for none, "99" for junk. */
  cites: string | null;
}

interface CorpusEvent {
  key: string;
  ts: string;
  text: string;
}

function corpus(): { loops: CorpusLoop[]; events: CorpusEvent[] } {
  const loops: CorpusLoop[] = [];
  const events: CorpusEvent[] = [];

  // 12 genuinely done, each with its own post-stated proof event.
  const doneIntents = [
    "Send Pranjali the Goa villa link",
    "Pay the electricity bill",
    "Book the Jaipur train tickets",
    "Return the drill to Rohan",
    "Share the wedding photos album",
    "Renew the car insurance",
    "Email the landlord about the leak",
    "Order the birthday cake",
    "Submit the visa documents",
    "Transfer rent for August",
    "Pick up the dry cleaning",
    "Confirm the dentist appointment",
  ];
  doneIntents.forEach((intent, i) => {
    const key = `proof${i + 1}`;
    events.push({
      key,
      ts: `${PROOF_DAY}T10:${String(10 + i).padStart(2, "0")}:00.000Z`,
      text: `done — ${intent.toLowerCase()} sorted ✔`,
    });
    loops.push({ loopId: `dl${i + 1}`, intent, trulyDone: true, code: "dn", cites: key });
  });

  // 2 NOT done: the model cites evidence that PRECEDES the loop's stating.
  events.push({ key: "old1", ts: `${BEFORE_DAY}T08:00:00.000Z`, text: "sent you that link last month btw" });
  events.push({ key: "old2", ts: `${BEFORE_DAY}T08:05:00.000Z`, text: "paid it already I think?" });
  loops.push({ loopId: "nd1", intent: "Send Kavya the new villa link", trulyDone: false, code: "dn", cites: "old1" });
  loops.push({ loopId: "nd2", intent: "Pay the water bill", trulyDone: false, code: "dn", cites: "old2" });

  // 1 guess (no event cited) and 1 junk citation — both NOT done.
  loops.push({ loopId: "nd3", intent: "Courier the spare keys", trulyDone: false, code: "dn", cites: "-" });
  loops.push({ loopId: "nd4", intent: "Fix the balcony light", trulyDone: false, code: "dn", cites: "99" });

  // 2 dropped (moot) with valid post-stated evidence — closes, but not DONE
  // closes, so outside the precision denominator by §12.9's own definition.
  events.push({ key: "moot1", ts: `${PROOF_DAY}T11:00:00.000Z`, text: "trip's cancelled, don't bother" });
  events.push({ key: "moot2", ts: `${PROOF_DAY}T11:05:00.000Z`, text: "we found another vendor, skip it" });
  loops.push({ loopId: "dr1", intent: "Book the Goa cab", trulyDone: false, code: "dr", cites: "moot1" });
  loops.push({ loopId: "dr2", intent: "Chase the old vendor quote", trulyDone: false, code: "dr", cites: "moot2" });

  // 1 possibly and 1 still open.
  events.push({ key: "maybe1", ts: `${PROOF_DAY}T12:00:00.000Z`, text: "will wrap that up tonight for sure" });
  loops.push({ loopId: "ps1", intent: "Send the invoice to accounts", trulyDone: false, code: "ps", cites: "maybe1" });
  loops.push({ loopId: "op1", intent: "Plan the Diwali trip", trulyDone: false, code: "op", cites: null });

  return { loops, events };
}

// ---------------------------------------------------------------------------
// Running the REAL pipeline over the corpus
// ---------------------------------------------------------------------------

export interface DoneCorpusRun {
  application: DoneApplication;
  trulyDone: ReadonlySet<string>;
  precision: ReturnType<typeof donePrecision>;
  observations: GateObservation[];
}

/**
 * Pack the corpus, author the frozen wire answer against the packed aliases,
 * parse it with the real parser and apply it with the real evidence checks.
 * Pure — no DB, no network, no clock.
 */
export function runDoneCorpus(): DoneCorpusRun {
  const { loops, events } = corpus();
  const sorted = [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  const eventIdOf = (key: string): string => `dc_ev_${key}`;
  const packEvents: PackEvent[] = sorted.map((e) => ({
    id: eventIdOf(e.key),
    streamId: "str_dc",
    at: e.ts,
    speakerId: SELF,
    text: e.text,
  }));
  const packed = packPrompt({
    tz: "Asia/Kolkata",
    entities: [{ id: OTHER, name: "Pranjali Sachdeva" }],
    streams: [{ id: "str_dc", name: "Pranjali Sachdeva", kind: "dm", participantIds: [SELF, OTHER] }],
    events: packEvents,
  });
  if (!packed.ok) throw new Error(`done corpus: packer refused (${packed.reason})`);

  // The alias each event was minted as — read back off the packer's own
  // table, never assumed from position.
  const eventAlias = (key: string): string => {
    const token = packed.table.eventToken(eventIdOf(key));
    if (!token) throw new Error(`done corpus: no alias for event ${key}`);
    return token;
  };

  const dd1Loops: Dd1Loop[] = loops.map((l) => ({
    loopId: l.loopId,
    intent: l.intent,
    ownerId: SELF,
    counterpartyId: OTHER,
    statedAt: STATED_AT,
  }));
  const prompt = buildDd1Prompt(dd1Loops, packed.text, packed.table);

  // The frozen answer, written in the aliases THIS prompt minted.
  const lines = loops.map((l) => {
    const alias = prompt.aliases[l.loopId];
    if (!alias) throw new Error(`done corpus: no alias for loop ${l.loopId}`);
    const ev = l.cites === null || l.cites === "-" ? "-" : l.cites === "99" ? "99" : eventAlias(l.cites);
    return `S|${alias}|${l.code}|${ev}|0.9|${l.intent.toLowerCase()}`;
  });

  const answer = parseDd1Response(lines.join("\n"), packed.table, dd1Loops);
  const eventTimes = new Map(sorted.map((e) => [eventIdOf(e.key), e.ts]));
  const application = applyDd1Answer(answer, dd1Loops, { eventTimes });

  const trulyDone = new Set(loops.filter((l) => l.trulyDone).map((l) => l.loopId));
  const precision = donePrecision(application, trulyDone);

  const observations: GateObservation[] = [];
  for (const outcome of application.outcomes) {
    if (outcome.action !== "close_done") continue;
    observations.push({
      gate: "loops_done_detection_precision",
      passed: trulyDone.has(outcome.loopId),
      note: `loop ${outcome.loopId} closed as done on ${outcome.evidenceEventId ?? "?"} — gold says ${trulyDone.has(outcome.loopId) ? "done" : "NOT done"}`,
    });
  }
  if (observations.length === 0) {
    // A pipeline that closed nothing has a different failure: recall collapsed.
    // Precision-as-1-over-zero must not read as a pass.
    observations.push({
      gate: "loops_done_detection_precision",
      passed: false,
      note: "the pipeline closed zero loops over a corpus with 12 genuinely-done loops",
    });
  }

  return { application, trulyDone, precision, observations };
}

let emitted = false;

/**
 * The corpus's observations, AT MOST ONCE per process — `runSuite` folds every
 * case's observations into one denominator, and a corpus that rode along on
 * every Q case would count each close many times over.
 */
export function doneCorpusObservations(): GateObservation[] {
  if (emitted) return [];
  const out = runDoneCorpus().observations;
  emitted = true;
  return out;
}

/** Test seam: let the next {@link doneCorpusObservations} emit again. */
export function resetDoneCorpusObservationsForTests(): void {
  emitted = false;
}
