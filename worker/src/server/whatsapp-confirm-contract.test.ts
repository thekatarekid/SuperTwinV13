// ===========================================================================
// POST /api/sources/whatsapp/confirm — the contract the UI's optimistic
// transition rests on (V6 P1 S6d L3).
//
// The panel now leaves the "Choose how far back" card the instant the button
// is pressed, and shows an import view that fills in as history lands. That is
// only honest if the route behaves the way this file pins it:
//
//   · confirm DISPATCHES the import and returns — it never waits for it. The
//     200 carries `importing: true` and the window it started on.
//   · `importDone` is still FALSE when that 200 lands. It flips only on the
//     daemon's own `backfill_complete`, which is minutes away over a real
//     history — so a client that waited on the response for the import to be
//     over would wait forever, and one that gated its screen on `importDone`
//     (the bug) would sit on the card for the whole import.
//   · a rejected window writes nothing and dispatches nothing, so the UI's
//     rollback has something true to roll back to.
//
// Real server on an ephemeral port (closed in afterAll), real temp DB, a
// scripted FakeChild for the daemon. Zero model calls, no child process.
// ===========================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "wa-confirm-contract-"));
process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
process.env.SUPERTWIN_HOME = tmpDir;

const { runMigrations, getDb } = await import("../db/connection.js");
const { setConsentGateMode } = await import("../db/consent-gate.js");
const { getConsent } = await import("../db/v6core.js");
const { WhatsAppAdapter } = await import("../adapters/whatsapp/adapter.js");
const { Ingestion } = await import("../ingest/index.js");
const { startServer } = await import("./index.js");
const { register } = await import("../providers/index.js");
const { claudeLocalProvider } = await import("../providers/claude-local/index.js");
const { setSourceSupervisor, SourceSupervisor } = await import("../adapters/supervisor.js");

/**
 * A daemon that ACCEPTS commands and says nothing back unless told to. The
 * silence is the point: it stands in for the real one, which takes minutes to
 * push a history and only then emits `backfill_complete`.
 */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  writes: string[] = [];
  stdin = {
    write: (c: string) => {
      this.writes.push(c);
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

interface StatusBody {
  paired: boolean;
  importDone?: boolean;
  importRange?: string;
}

beforeAll(async () => {
  runMigrations();
  register(claudeLocalProvider);
  prevMode = setConsentGateMode("enforce");
  child = new FakeChild();
  adapter = new WhatsAppAdapter({
    spawn: () => child as never,
    mock: true,
    autoRestart: false,
    home: tmpDir,
  });
  const ingestion = new Ingestion(adapter);
  ingestion.start();
  await adapter.connect();
  child.line({ t: "ready" });
  child.line({ t: "status", state: "online", jid: "me@x", push_name: "Me" });
  setSourceSupervisor(
    new SourceSupervisor({ drivers: { whatsapp: { start: () => {}, stop: () => {} } } }),
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

describe("POST /api/sources/whatsapp/confirm — dispatch, not completion", () => {
  it("a rejected window dispatches nothing, so there is a true state to roll back to", async () => {
    const { status, body } = await postJson<{ error: string }>(
      "/api/sources/whatsapp/confirm",
      { index: "30d", understand: "1y", card_text: "never shown" },
    );
    expect(status).toBe(400);
    expect(body.error).toBe("invalid-windows");
    expect(getConsent("whatsapp")).toBeNull();
    expect(child.commands().some((c) => c.cmd === "import")).toBe(false);
    const n = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM decisions WHERE target_kind <> 'provider_rollout'`)
      .get() as { n: number };
    expect(n.n).toBe(0);
  });

  it("returns as soon as the import is DISPATCHED — importing:true, range, importDone still false", async () => {
    const before = await getJson<StatusBody>("/api/sources/whatsapp/status");
    expect(before.body.importDone).toBe(false);

    const { status, body } = await postJson<{
      ok: boolean;
      importing: boolean;
      range: string;
      decision_id: string;
      consent: { state: string };
    }>("/api/sources/whatsapp/confirm", {
      index: "all",
      understand: "30d",
      card_text: "Index everything: 38,412 messages in 214 chats.",
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    // The two fields the client's optimistic transition reads: the yes landed
    // and the import has STARTED on this window.
    expect(body.importing).toBe(true);
    expect(body.range).toBe("all");
    expect(body.consent.state).toBe("connected");

    // The command really is on the wire — "started" is not a claim, it is a write.
    expect(child.commands().filter((c) => c.cmd === "import")).toEqual([
      { cmd: "import", range: "all" },
    ]);

    // And the import is NOT over: the daemon has said nothing back. A UI that
    // waits for importDone before leaving the confirm card waits for this, and
    // over a real history that is minutes of a dead-looking button.
    const after = await getJson<StatusBody>("/api/sources/whatsapp/status");
    expect(after.body.importDone).toBe(false);
    expect(after.body.importRange).toBe("all");
  });

  it("importDone flips only when the daemon says the history is over", async () => {
    expect(
      (await getJson<StatusBody>("/api/sources/whatsapp/status")).body.importDone,
    ).toBe(false);
    child.line({ t: "backfill_complete", range: "all", chats: 214 });
    await new Promise((r) => setTimeout(r, 20));
    const done = await getJson<StatusBody>("/api/sources/whatsapp/status");
    expect(done.body.importDone).toBe(true);
    expect(done.body.importRange).toBe("all");
  });
});
