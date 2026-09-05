// ===========================================================================
// [CODE] Consent routes — V6 P1 S1.8 (Build §4.2; backlog T4-10).
//
//   GET  /api/consent                 every live consent row + the card text
//                                     it was confirmed with (verbatim)
//   POST /api/consent/card            {source, index_all?, index_from?,
//                                      understand_from, counts?} → the card,
//                                     NO write — the preview the flow renders
//                                     while the user moves the windows
//   POST /api/consent/confirm         same body → grant (or re-confirm) the
//                                     consent, store the card text in
//                                     `decisions`, then start the adapter
//                                     through the supervisor (S1.3)
//
// `counts` is what the source flow measured before consent (S1.4 profile
// counts, S1.5 messagesInRange). Without it the worker counts the log — right
// on a re-confirm, and honestly "—" on a first connect, because nothing is
// in the log before yes (CNS-01).
// ===========================================================================

import { type IncomingMessage, type ServerResponse } from "node:http";

import {
  SUPERVISED_SOURCES,
  getSourceSupervisor,
  type SupervisedSource,
} from "../adapters/supervisor.js";
import {
  buildConfirmCard,
  confirmConsent,
  confirmedCardText,
  type CardCounts,
  type CardInput,
} from "../consent/confirm-card.js";
import { ConsentWindowError, listConsents } from "../db/v6core.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function isoOrNull(v: unknown, field: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) {
    throw new CardBodyError(`${field} must be an ISO timestamp or null`);
  }
  return v;
}

class CardBodyError extends Error {}

function parseCounts(v: unknown): CardCounts | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object") throw new CardBodyError("counts must be an object");
  const c = v as Record<string, unknown>;
  const num = (x: unknown, name: string): number | null => {
    if (x === undefined || x === null) return null;
    if (typeof x !== "number" || !Number.isFinite(x) || x < 0) {
      throw new CardBodyError(`counts.${name} must be a non-negative number or null`);
    }
    return Math.floor(x);
  };
  return {
    index: num(c.index, "index"),
    understand: num(c.understand, "understand"),
    exact: c.exact !== false,
  };
}

/** Body → CardInput; throws CardBodyError with the message to send back. */
export function parseCardBody(body: Record<string, unknown> | undefined): CardInput & { scope?: unknown } {
  if (!body || typeof body.source !== "string" || body.source.trim() === "") {
    throw new CardBodyError("source (string) required");
  }
  const indexFrom = isoOrNull(body.index_from, "index_from");
  const indexAll = body.index_all === undefined ? indexFrom === null : body.index_all === true;
  if (!indexAll && indexFrom === null) {
    throw new CardBodyError("index_from required when index_all is false");
  }
  if (!("understand_from" in body)) {
    throw new CardBodyError("understand_from (ISO or null) required");
  }
  return {
    source: body.source,
    indexAll,
    indexFrom: indexAll ? null : indexFrom,
    understandFrom: isoOrNull(body.understand_from, "understand_from"),
    counts: parseCounts(body.counts),
    scope: body.scope,
  };
}

export async function handleConsentRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (req.method === "GET" && path === "/api/consent") {
    const consents = listConsents().map((c) => ({
      id: c.id,
      source: c.source,
      state: c.state,
      granted_at: c.grantedAt,
      granted_build: c.grantedBuild,
      index_all: c.indexAll,
      index_from: c.indexFrom,
      understand_from: c.understandFrom,
      decision_id: c.decisionId,
      card_text: confirmedCardText(c),
    }));
    sendJson(res, 200, { consents });
    return true;
  }

  if (req.method === "POST" && (path === "/api/consent/card" || path === "/api/consent/confirm")) {
    let input: CardInput & { scope?: unknown };
    try {
      input = parseCardBody(await readBody(req));
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }
    try {
      if (path === "/api/consent/card") {
        sendJson(res, 200, { card: buildConfirmCard(input) });
        return true;
      }
      const result = confirmConsent(input);
      // S1.3: the adapter starts only on a connected consent row — now there
      // is one. Best effort: a failed start is reported, never hidden, and the
      // consent (and the card text) are already durable.
      let started: string = "no-supervisor";
      const supervisor = getSourceSupervisor();
      if (supervisor && (SUPERVISED_SOURCES as readonly string[]).includes(input.source)) {
        try {
          const outcome = await supervisor.start(input.source as SupervisedSource);
          started = outcome.started ? "started" : outcome.reason;
        } catch (err) {
          started = `error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      sendJson(res, 200, {
        consent: {
          id: result.consent.id,
          source: result.consent.source,
          state: result.consent.state,
          index_all: result.consent.indexAll,
          index_from: result.consent.indexFrom,
          understand_from: result.consent.understandFrom,
          decision_id: result.decisionId,
        },
        card: result.card,
        decision_id: result.decisionId,
        change: result.change,
        replayed: result.replayed,
        started,
      });
      return true;
    } catch (err) {
      if (err instanceof ConsentWindowError) {
        sendJson(res, 400, { error: err.message, code: "understand-exceeds-index" });
        return true;
      }
      throw err;
    }
  }

  return false;
}
