// ===========================================================================
// Consent routes (V6 P1 S1.8): the card preview writes nothing, confirm
// grants + stores the card verbatim + asks the supervisor to start, bad
// bodies and CNS-03 pairs come back as 400s. Zero model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";

import { SourceSupervisor, setSourceSupervisor } from "../adapters/supervisor.js";
import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { setConsentGateMode, type ConsentGateMode } from "../db/consent-gate.js";
import { getConsent } from "../db/v6core.js";
import { handleConsentRoute, parseCardBody } from "./consent-routes.js";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const DAY = 86_400_000;
const daysAgo = (n: number): string => new Date(NOW - n * DAY).toISOString();

let tmpDir: string;
let server: Server;
let base: string;
let prevMode: ConsentGateMode;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-consent-routes-"));
  process.env.SUPERTWIN_HOME = tmpDir;
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  prevMode = setConsentGateMode("enforce");
  server = createServer((req, res) => {
    void handleConsentRoute(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  setSourceSupervisor(null);
  setConsentGateMode(prevMode);
  await new Promise<void>((r) => server.close(() => r()));
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_HOME;
  rmSync(tmpDir, { recursive: true, force: true });
});

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function get(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path);
  return { status: res.status, json: await res.json() };
}

describe("POST /api/consent/card", () => {
  it("returns the four numbers with their accuracy labels and writes nothing", async () => {
    const { status, json } = await post("/api/consent/card", {
      source: "whatsapp",
      index_all: true,
      understand_from: daysAgo(30),
      counts: { index: 40, understand: 30, exact: true },
    });
    expect(status).toBe(200);
    const card = json.card;
    expect(card.events).toMatchObject({ value: 30, accuracy: "exact" });
    expect(card.cost.accuracy).toBe("estimate ±40%");
    expect(card.time.accuracy).toBe("estimate ±30%");
    expect(card.disk.accuracy).toBe("about");
    expect(typeof card.text).toBe("string");
    expect(getConsent("whatsapp")).toBeNull();
    expect(
      (
        getDb()
          .prepare(`SELECT COUNT(*) AS n FROM decisions WHERE target_kind <> 'provider_rollout'`)
          .get() as { n: number }
      ).n,
    ).toBe(0);
  });

  it("400 on a missing source, a missing understand_from, or a bad timestamp", async () => {
    expect((await post("/api/consent/card", { understand_from: null })).status).toBe(400);
    expect((await post("/api/consent/card", { source: "whatsapp" })).status).toBe(400);
    expect(
      (await post("/api/consent/card", { source: "whatsapp", understand_from: "yesterday" })).status,
    ).toBe(400);
    expect(
      (await post("/api/consent/card", { source: "whatsapp", index_all: false, understand_from: null }))
        .status,
    ).toBe(400);
  });

  it("400 with code understand-exceeds-index on a CNS-03 pair", async () => {
    const { status, json } = await post("/api/consent/card", {
      source: "whatsapp",
      index_all: false,
      index_from: daysAgo(30),
      understand_from: daysAgo(90),
    });
    expect(status).toBe(400);
    expect(json.code).toBe("understand-exceeds-index");
  });
});

describe("POST /api/consent/confirm", () => {
  it("grants the consent, stores the card verbatim, starts the source through the supervisor", async () => {
    const started: string[] = [];
    setSourceSupervisor(
      new SourceSupervisor({
        drivers: {
          whatsapp: {
            start: () => {
              started.push("whatsapp");
            },
            stop: () => {},
          },
        },
      }),
    );
    const { status, json } = await post("/api/consent/confirm", {
      source: "whatsapp",
      index_all: true,
      understand_from: daysAgo(30),
      counts: { index: 40, understand: 30, exact: true },
      scope: { chats: "all" },
    });
    expect(status).toBe(200);
    expect(json.change).toBe("granted");
    expect(json.started).toBe("started");
    expect(started).toEqual(["whatsapp"]);

    const live = getConsent("whatsapp")!;
    expect(live.state).toBe("connected");
    expect(live.indexAll).toBe(true);
    expect(live.understandFrom).toBe(daysAgo(30));
    expect(live.decisionId).toBe(json.decision_id);
    expect(json.consent.decision_id).toBe(json.decision_id);
    const row = getDb().prepare(`SELECT reason, target_id FROM decisions WHERE id = ?`).get(json.decision_id) as {
      reason: string;
      target_id: string;
    };
    expect(row.reason).toBe(json.card.text);
    expect(row.target_id).toBe(live.id);

    const listed = await get("/api/consent");
    expect(listed.status).toBe(200);
    expect(listed.json.consents).toHaveLength(1);
    expect(listed.json.consents[0]).toMatchObject({
      source: "whatsapp",
      state: "connected",
      index_all: true,
      understand_from: daysAgo(30),
      decision_id: json.decision_id,
      card_text: json.card.text,
    });
  });

  it("without a supervisor the consent is still durable and the response says so", async () => {
    const { status, json } = await post("/api/consent/confirm", {
      source: "browser",
      index_all: true,
      understand_from: daysAgo(7),
    });
    expect(status).toBe(200);
    expect(json.started).toBe("no-supervisor");
    expect(getConsent("browser")).not.toBeNull();
    // First connect, no counts, nothing in the log: the card says so instead
    // of inventing a number.
    expect(json.card.events.value).toBeNull();
    expect(json.card.events.display).toBe("—");
  });

  it("a second confirm re-confirms the same row and records the change", async () => {
    await post("/api/consent/confirm", { source: "screen", index_all: true, understand_from: daysAgo(7) });
    const first = getConsent("screen")!;
    const { json } = await post("/api/consent/confirm", {
      source: "screen",
      index_all: true,
      understand_from: daysAgo(30),
    });
    expect(json.change).toBe("widened");
    expect(json.consent.id).toBe(first.id);
    expect(json.decision_id).not.toBe(first.decisionId);
    expect(getConsent("screen")!.understandFrom).toBe(daysAgo(30));
  });

  it("400 on a CNS-03 pair, nothing written", async () => {
    const { status, json } = await post("/api/consent/confirm", {
      source: "whatsapp",
      index_all: false,
      index_from: daysAgo(30),
      understand_from: daysAgo(90),
    });
    expect(status).toBe(400);
    expect(json.code).toBe("understand-exceeds-index");
    expect(getConsent("whatsapp")).toBeNull();
  });

  it("unknown paths are not claimed", async () => {
    expect((await get("/api/consent/nope")).status).toBe(404);
  });
});

describe("parseCardBody", () => {
  it("index_all defaults from index_from; counts.exact defaults true", () => {
    const a = parseCardBody({ source: "whatsapp", understand_from: null });
    expect(a).toMatchObject({ indexAll: true, indexFrom: null, understandFrom: null, counts: null });
    const b = parseCardBody({ source: "whatsapp", index_from: daysAgo(90), understand_from: daysAgo(30), counts: { index: 3 } });
    expect(b).toMatchObject({ indexAll: false, indexFrom: daysAgo(90), counts: { index: 3, understand: null, exact: true } });
    expect(() => parseCardBody({ source: "whatsapp", understand_from: null, counts: { index: -1 } })).toThrow();
  });
});
