// ===========================================================================
// Send gate + v13 envelope emission tests (P0.6) with a FAKE daemon.
//
// The send path is triple-gated and this file proves the two worker layers:
//   - adapter.sendMessage refuses (throws) without a token — nothing reaches
//     the daemon's stdin;
//   - Ingestion.sendMessage consumes the single-use token first: an invalid /
//     used / expired token throws and the adapter is never called;
//   - a valid mint drives exactly ONE send_message line; replaying it fails.
// (The third layer — the daemon's own refusal — is covered by Go tests.)
//
// Envelope emission: scripted daemon frames produce spec §6.1 envelopes with
// roster-derived audience, structural mentions, and reply markers.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { mintApprovalToken } from "../../approvals/tokens.js";
import { Ingestion } from "../../ingest/index.js";
import type { StatusUpdate } from "../types.js";
import type { V13Envelope } from "./envelope.js";
import { WhatsAppAdapter, type ChildLike, type SpawnFn } from "./adapter.js";

class FakeChild extends EventEmitter implements ChildLike {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  readonly writes: string[] = [];
  pid = 4243;
  stdin = {
    write: (chunk: string) => {
      this.writes.push(chunk);
    },
    end: () => {},
  };
  kill(): boolean {
    setImmediate(() => this.emit("exit", 0, null));
    return true;
  }
  line(obj: unknown): void {
    this.stdout.emit("data", JSON.stringify(obj) + "\n");
  }
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wa-send-gate-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  process.env.SUPERTWIN_HOME = tmpDir;
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_HOME;
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeAdapter(): { adapter: WhatsAppAdapter; child: FakeChild } {
  const child = new FakeChild();
  const spawn: SpawnFn = () => child;
  const adapter = new WhatsAppAdapter({
    spawn,
    mock: true,
    autoRestart: false,
    home: tmpDir,
  });
  return { adapter, child };
}

function sentCommands(child: FakeChild): Array<Record<string, unknown>> {
  return child.writes.map((w) => JSON.parse(w) as Record<string, unknown>);
}

describe("send gate (P0.6)", () => {
  it("adapter refuses a send without a token — nothing reaches stdin", async () => {
    const { adapter, child } = makeAdapter();
    await adapter.connect();
    child.line({ t: "ready" });

    await expect(adapter.sendMessage("x@s.whatsapp.net", "hi", "")).rejects.toThrow(
      /SEND_REFUSED/,
    );
    expect(
      sentCommands(child).filter((c) => c.cmd === "send_message"),
    ).toHaveLength(0);
  });

  it("Ingestion refuses an unknown token; adapter never called", async () => {
    const { adapter, child } = makeAdapter();
    const ingestion = new Ingestion(adapter);
    ingestion.start();
    await adapter.connect();
    child.line({ t: "ready" });

    await expect(
      ingestion.sendMessage({
        to: "x@s.whatsapp.net",
        text: "hi",
        approvalToken: "not-a-real-token",
      }),
    ).rejects.toThrow(/SEND_REFUSED/);
    expect(
      sentCommands(child).filter((c) => c.cmd === "send_message"),
    ).toHaveLength(0);
  });

  it("a minted token sends exactly once; the replay is refused", async () => {
    const { adapter, child } = makeAdapter();
    const ingestion = new Ingestion(adapter);
    ingestion.start();
    await adapter.connect();
    child.line({ t: "ready" });

    const t = mintApprovalToken(`${ingestion.sourceId}.send`);
    await ingestion.sendMessage({
      to: "x@s.whatsapp.net",
      text: "approved hello",
      approvalToken: t.token,
    });

    const sends = sentCommands(child).filter((c) => c.cmd === "send_message");
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      to: "x@s.whatsapp.net",
      text: "approved hello",
      approval_token: t.token,
    });

    // Single-use: the same token cannot authorize a second send.
    await expect(
      ingestion.sendMessage({
        to: "x@s.whatsapp.net",
        text: "again",
        approvalToken: t.token,
      }),
    ).rejects.toThrow(/SEND_REFUSED/);
    expect(
      sentCommands(child).filter((c) => c.cmd === "send_message"),
    ).toHaveLength(1);
  });

  it("a token minted for another action is refused", async () => {
    const { adapter, child } = makeAdapter();
    const ingestion = new Ingestion(adapter);
    ingestion.start();
    await adapter.connect();
    child.line({ t: "ready" });

    const t = mintApprovalToken("browser.payment");
    await expect(
      ingestion.sendMessage({
        to: "x@s.whatsapp.net",
        text: "hi",
        approvalToken: t.token,
      }),
    ).rejects.toThrow(/SEND_REFUSED/);
    expect(
      sentCommands(child).filter((c) => c.cmd === "send_message"),
    ).toHaveLength(0);
  });

  it("forwards the daemon's send_result frame as a status update", async () => {
    const { adapter, child } = makeAdapter();
    const updates: StatusUpdate[] = [];
    adapter.onStatus((s) => updates.push(s));
    await adapter.connect();
    child.line({ t: "ready" });

    child.line({ t: "send_result", ok: true, external_id: "x@s.whatsapp.net/ID9" });
    child.line({ t: "send_result", ok: false, detail: "not paired" });

    const results = updates.filter((u) => u.type === "send_result");
    expect(results).toEqual([
      { type: "send_result", ok: true, externalId: "x@s.whatsapp.net/ID9" },
      { type: "send_result", ok: false, detail: "not paired" },
    ]);
  });
});

describe("v13 envelope emission (spec §6.1)", () => {
  it("attaches envelopes with roster-built audience, mentions, reply markers — and they land on the event row", async () => {
    const { adapter, child } = makeAdapter();
    const ingestion = new Ingestion(adapter);
    ingestion.start();
    const envelopes: V13Envelope[] = [];
    adapter.onEvent((e) => {
      if (e.envelope) envelopes.push(e.envelope);
    });
    await adapter.connect();
    child.line({ t: "ready" });
    child.line({ t: "paired", jid: "me@s.whatsapp.net", push_name: "Me" });

    const ts = new Date().toISOString();
    const base = { t: "event" };
    child.line({
      ...base,
      event: {
        external_id: "g@g.us/M1",
        channel_ext_id: "g@g.us",
        actor_ext_id: "rohan@s.whatsapp.net",
        ts,
        kind: "message",
        text: "goa?",
        from_me: false,
        media: null,
        reply_to: null,
        raw: {},
      },
    });
    child.line({
      ...base,
      event: {
        external_id: "g@g.us/M2",
        channel_ext_id: "g@g.us",
        actor_ext_id: "tanvi@s.whatsapp.net",
        ts,
        kind: "message",
        text: "@rohan yes!",
        from_me: false,
        media: null,
        mentioned_ext_ids: ["rohan@s.whatsapp.net"],
        reply_to: {
          external_id: "g@g.us/M1",
          text: "goa?",
          actor_ext_id: "rohan@s.whatsapp.net",
        },
        raw: {},
      },
    });

    expect(envelopes).toHaveLength(2);
    const [first, second] = envelopes;
    expect(first.roles.sender).toBe("rohan@s.whatsapp.net");
    expect(first.roles.audience).toEqual(["self", "rohan@s.whatsapp.net"]);
    expect(first.origin).toBe("live");
    expect(first.age_band).toBe("A");

    // The roster GREW: tanvi's message sees rohan already on the stream.
    expect(second.roles.audience).toEqual([
      "self",
      "rohan@s.whatsapp.net",
      "tanvi@s.whatsapp.net",
    ]);
    expect(second.roles.mentions).toEqual(["rohan@s.whatsapp.net"]);
    expect(second.payload.reply_to).toEqual({
      external_id: "g@g.us/M1",
      text: "goa?",
      actor: "rohan@s.whatsapp.net",
    });
    expect(second.stream_key).toBe("wa:g@g.us"); // S3.4: wa:<jid>
    expect(second.kind).toBe("wa.message");

    // The envelope is STAMPED onto the ingested rows' v13 columns
    // (0100_v13_core): roles/age_band/origin/stream_key persist verbatim.
    const rows = getDb()
      .prepare(
        `SELECT external_id, origin, age_band, stream_key, actor, roles_json, payload_json
           FROM events ORDER BY external_id`,
      )
      .all() as Array<Record<string, string>>;
    expect(rows).toHaveLength(2);
    expect(rows[0].external_id).toBe("g@g.us/M1");
    expect(rows[0].origin).toBe("live");
    expect(rows[0].age_band).toBe("A");
    expect(rows[0].stream_key).toBe("wa:g@g.us");
    const storedRoles = JSON.parse(rows[1].roles_json) as {
      sender: string;
      audience: string[];
      receiver: string[];
      mentions: string[];
    };
    expect(storedRoles.sender).toBe("tanvi@s.whatsapp.net");
    expect(storedRoles.audience).toEqual([
      "self",
      "rohan@s.whatsapp.net",
      "tanvi@s.whatsapp.net",
    ]);
    expect(storedRoles.receiver).toEqual(["*audience"]);
    expect(storedRoles.mentions).toEqual(["rohan@s.whatsapp.net"]);
    const storedPayload = JSON.parse(rows[1].payload_json) as Record<string, unknown>;
    expect(storedPayload.reply_to).toEqual({
      external_id: "g@g.us/M1",
      text: "goa?",
      actor: "rohan@s.whatsapp.net",
    });
  });
});
