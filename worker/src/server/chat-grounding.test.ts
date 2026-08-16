// Resolving a citation back to the message it points at.
//
// The context block prints the short form of an event id — a
// WhatsApp id is `wa:<chat jid>/<stanza>` and the jid half repeats the chat the
// section header already names, ~7,900 chars of one measured section (v7 §6,
// lever 5). Shortening it is only safe because this resolves it, so this is
// where that claim is checked: a whole id, the tail the block printed, and a
// tail two events share — which resolves to NEITHER, because a citation chip
// pointing at the wrong message is worse than one that says it cannot find it.

process.env.TZ = "Asia/Kolkata";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "st-citations-"));
process.env.SUPERTWIN_DB_PATH = join(tmpRoot, "test.db");
process.env.SUPERTWIN_BRAIN_DIR = join(tmpRoot, "brain");
process.env.SUPERTWIN_SEMANTIC_RETRIEVAL = "0";

const { closeDb, getDb } = await import("../db/connection.js");
const { runMigrations } = await import("../db/index.js");
const { getEventDetail, buildContextBlock } = await import("./chat-grounding.js");
const { shortEventId } = await import("../retrieval/index.js");

const CHAT = "919000000011@s.whatsapp.net";
const OTHER = "919000000012@s.whatsapp.net";
const STANZA = "3B698EC76C2C1C91AC18";
/** The same stanza id in two chats — rare, and the reason for the LIMIT 2. */
const SHARED = "3A162CE1E5C9769A30B0";

const HIT = `wa:${CHAT}/${STANZA}`;

beforeAll(() => {
  runMigrations();
  const db = getDb();
  db.prepare(`INSERT INTO sources (id, type) VALUES ('whatsapp', 'whatsapp')`).run();
  const channel = db.prepare(
    `INSERT INTO channels (id, source_id, name, kind) VALUES (?, 'whatsapp', ?, 'dm')`,
  );
  channel.run(`whatsapp:st:${CHAT}`, "Priya");
  channel.run(`whatsapp:st:${OTHER}`, "Rashmi");
  db.prepare(
    `INSERT INTO actors (id, source_id, display_name) VALUES ('ac-1', 'whatsapp', 'Priya')`,
  ).run();

  const event = db.prepare(`
    INSERT INTO events (id, source_id, source_type, channel_id, actor_id, ts, kind, text, external_id)
    VALUES (?, 'whatsapp', 'whatsapp', ?, 'ac-1', ?, 'message', ?, ?)
  `);
  event.run(
    HIT,
    `whatsapp:st:${CHAT}`,
    "2026-07-27T09:21:17.000Z",
    "sunday lunch chalna hai kahin?",
    `${CHAT}/${STANZA}`,
  );
  event.run(
    `wa:${CHAT}/${SHARED}`,
    `whatsapp:st:${CHAT}`,
    "2026-07-27T09:34:30.000Z",
    "Haan Haan. It's a definite watch",
    `${CHAT}/${SHARED}`,
  );
  event.run(
    `wa:${OTHER}/${SHARED}`,
    `whatsapp:st:${OTHER}`,
    "2026-07-27T09:40:00.000Z",
    "different chat, same stanza",
    `${OTHER}/${SHARED}`,
  );
  event.run("plain", `whatsapp:st:${CHAT}`, "2026-07-27T09:45:00.000Z", "no slash", "plain");
});

afterAll(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("getEventDetail", () => {
  it("resolves the id the block actually printed", () => {
    const block = buildContextBlock("sunday lunch", { now: new Date("2026-07-31T09:00:00Z") });
    expect(block).toContain(`[evt ${STANZA}]`);
    expect(block).not.toContain(HIT);

    const row = getEventDetail(STANZA);
    expect(row).toMatchObject({ id: HIT, text: "sunday lunch chalna hai kahin?" });
  });

  it("still resolves the whole id, from an older citation or a hand-typed one", () => {
    expect(getEventDetail(HIT)?.id).toBe(HIT);
  });

  it("refuses a tail two events share rather than guessing between them", () => {
    expect(getEventDetail(`wa:${CHAT}/${SHARED}`)?.text).toBe("Haan Haan. It's a definite watch");
    expect(getEventDetail(SHARED)).toBeNull();
  });

  it("leaves an id with nothing to shorten alone", () => {
    expect(shortEventId("plain")).toBe("plain");
    expect(getEventDetail("plain")?.text).toBe("no slash");
  });

  it("is null for what it cannot find, and for nothing at all", () => {
    expect(getEventDetail("3A0000000000000000NO")).toBeNull();
    expect(getEventDetail("")).toBeNull();
    // A partial tail is not a tail: it matches on the whole segment or not.
    expect(getEventDetail(STANZA.slice(4))).toBeNull();
  });
});
