// ===========================================================================
// GET /api/sources/whatsapp/counts + POST /api/sources/whatsapp/confirm — the
// connect flow's HTTP edge (V6 P1 S1.5, T4-7 / T4-10). Real server on an
// ephemeral port (closed in afterAll), real temp DB, an Ingestion over the real
// adapter framing with a scripted FakeChild answering `count_range`, and a spy
// WhatsApp driver on the source supervisor. Zero model calls, no child process.
// ===========================================================================

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "wa-connect-routes-"));
process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
process.env.SUPERTWIN_HOME = tmpDir;

const { runMigrations, getDb } = await import("../db/connection.js");
const { setConsentGateMode } = await import("../db/consent-gate.js");
const { getConsent } = await import("../db/v6core.js");
const { appStateGet, importRangeKey } = await import("../db/ingest.js");
const { WhatsAppAdapter } = await import("../adapters/whatsapp/adapter.js");
const { Ingestion } = await import("../ingest/index.js");
const { startServer } = await import("./index.js");
const { register } = await import("../providers/index.js");
const { claudeLocalProvider } = await import("../providers/claude-local/index.js");
const { setSourceSupervisor, SourceSupervisor } = await import("../adapters/supervisor.js");
type StartContext = import("../adapters/supervisor.js").StartContext;

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  writes: string[] = [];
  answerCounts = true;
  stdin = {
    write: (c: string) => {
      this.writes.push(c);
      if (this.answerCounts && c.includes('"cmd":"count_range"')) {
        setImmediate(() =>
          this.line({
            t: "range_counts",
            counts: {
              "24h": { chats: 3, messages: 41 },
              "3d": { chats: 5, messages: 120 },
              "7d": { chats: 12, messages: 1597 },
              "30d": { chats: 40, messages: 6091 },
              "90d": { chats: 80, messages: 8131 },
              "180d": { chats: 80, messages: 8131 },
              "1y": { chats: 80, messages: 8131 },
              "2y": { chats: 80, messages: 8131 },
              "3y": { chats: 80, messages: 8131 },
              "4y": { chats: 80, messages: 8131 },
              "5y": { chats: 80, messages: 8131 },
              all: { chats: 80, messages: 8131 },
            },
            chats: 80,
            messages: 8131,
            oldest_ts: new Date(Date.now() - 100 * 86_400_000).toISOString(),
            newest_ts: new Date().toISOString(),
            buffered_batches: 2,
            batches: 2,
            sync_types: ["INITIAL_BOOTSTRAP"],
            range_installed: false,
            pending_live: 3,
          }),
        );
      }
    },
    end: () => {},
  };
  kill() {
    setImmediate(() => this.emit("exit", 0, null));
    return true;
  }
  line(obj: unknown) {
    this.stdout.emit("data", JSON.stringify(obj) + "\n");
  }
  commands(): Array<Record<string, unknown>> {
    return this.writes.map((w) => JSON.parse(w) as Record<string, unknown>);
  }
}

type ServerHandle = { port: number; close(): Promise<void> };

let server: ServerHandle;
let base: string;
let child: FakeChild;
let adapter: InstanceType<typeof WhatsAppAdapter>;
const driverStarts: StartContext[] = [];
let prevMode: ReturnType<typeof setConsentGateMode>;

async function getJson<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: (await res.json()) as T };
}

async function postJson<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

beforeAll(async () => {
  runMigrations();
  register(claudeLocalProvider);
  prevMode = setConsentGateMode("enforce");
  child = new FakeChild();
  adapter = new WhatsAppAdapter({ spawn: () => child as never, mock: true, autoRestart: false, home: tmpDir });
  const ingestion = new Ingestion(adapter);
  ingestion.start();
  await adapter.connect();
  child.line({ t: "ready" });
  child.line({ t: "status", state: "online", jid: "me@x", push_name: "Me" });
  setSourceSupervisor(
    new SourceSupervisor({
      drivers: {
        whatsapp: {
          start: (ctx) => void driverStarts.push(ctx),
          stop: () => {},
        },
      },
    }),
  );
  server = await startServer({ port: 0, ingestion });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.close();
  setSourceSupervisor(null);
  setConsentGateMode(prevMode);
  await adapter.disconnect();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_HOME;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/sources/whatsapp/counts", () => {
  it("returns the daemon's measured counts, the card rows and the honest caveats — and installs nothing", async () => {
    const { status, body } = await getJson<{
      counts: { messages: number; chats: number; syncTypes: string[]; pendingLive: number; rangeInstalled: boolean };
      windows: Array<{ range: string; chats: number; messages: number; days: number; accuracy: string }>;
      caveats: string[];
    }>("/api/sources/whatsapp/counts");
    expect(status).toBe(200);
    expect(body.counts.messages).toBe(8131);
    expect(body.counts.chats).toBe(80);
    expect(body.counts.rangeInstalled).toBe(false);
    const w7 = body.windows.find((w) => w.range === "7d")!;
    expect(w7).toMatchObject({ chats: 12, messages: 1597, days: 7, accuracy: "so-far" });
    const all = body.windows.find((w) => w.range === "all")!;
    expect([100, 101]).toContain(all.days); // ceil over the ms elapsed since the frame
    expect(body.caveats.some((c) => /bootstrap batch so far/.test(c))).toBe(true);
    expect(body.caveats.some((c) => /3 messages arrived since pairing and are held/.test(c))).toBe(true);
    // Read-only: one count_range on the wire, no range installed, no consent.
    expect(child.commands().filter((c) => c.cmd === "count_range")).toHaveLength(1);
    expect(child.commands().some((c) => c.cmd === "set_range" || c.cmd === "import")).toBe(false);
    expect(getConsent("whatsapp")).toBeNull();
  });

  it("503 counts-unavailable when the daemon cannot answer — never a 200 with invented numbers", async () => {
    const spy = vi
      .spyOn(adapter, "countRange")
      .mockRejectedValueOnce(new Error("COUNTS_UNAVAILABLE: daemon did not answer count_range in time"));
    const { status, body } = await getJson<{ error: string; detail: string }>("/api/sources/whatsapp/counts");
    expect(status).toBe(503);
    expect(body.error).toBe("counts-unavailable");
    expect(body.detail).toMatch(/COUNTS_UNAVAILABLE/);
    spy.mockRestore();
  });
});

describe("POST /api/sources/whatsapp/confirm", () => {
  it("400 on inconsistent windows, nothing written", async () => {
    const { status, body } = await postJson<{ error: string; detail: string }>(
      "/api/sources/whatsapp/confirm",
      { index: "30d", understand: "1y", card_text: "never" },
    );
    expect(status).toBe(400);
    expect(body.error).toBe("invalid-windows");
    expect(body.detail).toMatch(/Understand never exceeds Index/);
    expect(getConsent("whatsapp")).toBeNull();
    const n = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM decisions WHERE target_kind <> 'provider_rollout'`)
      .get() as { n: number };
    expect(n.n).toBe(0);
    expect(child.commands().some((c) => c.cmd === "import")).toBe(false);
  });

  it("the yes: card verbatim in decisions → consent connected → driver started under it → import <index> on the wire", async () => {
    const cardText = "Index last 90 days: 8,131 messages in 80 chats (so far).\nUnderstand last 30 days: 6,091 messages.";
    const { status, body } = await postJson<{
      ok: boolean;
      consent: { id: string; state: string; indexAll: boolean; indexFrom: string | null; understandFrom: string | null; decisionId: string };
      decision_id: string;
    }>("/api/sources/whatsapp/confirm", { index: "90d", understand: "30d", card_text: cardText });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.consent.state).toBe("connected");
    expect(body.consent.indexAll).toBe(false);
    expect(body.consent.indexFrom).not.toBeNull();
    expect(body.consent.understandFrom).not.toBeNull();
    expect(body.consent.decisionId).toBe(body.decision_id);

    const live = getConsent("whatsapp")!;
    expect(live.id).toBe(body.consent.id);
    const dec = getDb().prepare(`SELECT reason, new_json FROM decisions WHERE id = ?`).get(body.decision_id) as {
      reason: string;
      new_json: string;
    };
    expect(dec.reason).toBe(cardText);
    expect((JSON.parse(dec.new_json) as { card_text: string }).card_text).toBe(cardText);

    // The supervisor started the source UNDER the new consent row…
    expect(driverStarts).toHaveLength(1);
    expect(driverStarts[0].consent?.id).toBe(live.id);
    // …and the import of the confirmed INDEX window went to the daemon, with
    // the range persisted for the next boot's set_range.
    const imports = child.commands().filter((c) => c.cmd === "import");
    expect(imports).toEqual([{ cmd: "import", range: "90d" }]);
    expect(appStateGet(importRangeKey("whatsapp"))).toBe("90d");
  });
});
