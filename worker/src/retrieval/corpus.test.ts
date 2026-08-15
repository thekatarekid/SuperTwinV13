// ===========================================================================
// The searchable corpus (docs/v6-spec.md §1, tier 2).
//
// What has to hold: the messages are on disk where Grep reaches them, one per
// line; a turn rewrites only the chats that moved; and nothing a stranger typed
// into a group title can write outside the corpus folder.
// ===========================================================================

process.env.TZ = "Asia/Kolkata";

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "st-corpus-"));
process.env.SUPERTWIN_DB_PATH = join(tmpRoot, "test.db");
process.env.SUPERTWIN_BRAIN_DIR = join(tmpRoot, "brain");

const { closeDb, getDb } = await import("../db/connection.js");
const { runMigrations } = await import("../db/index.js");
const { corpusRelativePath, corpusRoot, refreshCorpus, resetCorpusCacheForTests } =
  await import("./corpus.js");

let seq = 0;

function addChannel(id: string, name: string, kind = "dm"): void {
  getDb()
    .prepare(
      `INSERT INTO channels (id, source_id, name, kind) VALUES (?, 'whatsapp', ?, ?)`,
    )
    .run(id, name, kind);
}

function addEvent(
  channelId: string,
  text: string,
  extra: { kind?: string; ts?: string; transcript?: string } = {},
): string {
  const id = `evt-${++seq}`;
  getDb()
    .prepare(
      `INSERT INTO events (id, source_id, source_type, channel_id, actor_id, ts, kind, text,
                           external_id, transcript)
       VALUES (?, 'whatsapp', 'whatsapp', ?, 'ac-1', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      channelId,
      extra.ts ?? `2026-07-${String(10 + seq).padStart(2, "0")}T04:00:00.000Z`,
      extra.kind ?? "message",
      text,
      id,
      extra.transcript ?? null,
    );
  return id;
}

function corpusFiles(): string[] {
  return readdirSync(corpusRoot())
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort();
}

function read(file: string): string {
  return readFileSync(join(corpusRoot(), file), "utf8");
}

beforeEach(() => {
  runMigrations();
  getDb().prepare(`INSERT INTO sources (id, type) VALUES ('whatsapp', 'whatsapp')`).run();
  getDb()
    .prepare(
      `INSERT INTO actors (id, source_id, display_name) VALUES ('ac-1', 'whatsapp', 'Rahul')`,
    )
    .run();
  resetCorpusCacheForTests();
});

afterEach(() => {
  closeDb();
  rmSync(join(tmpRoot, "test.db"), { force: true });
  rmSync(join(tmpRoot, "brain"), { recursive: true, force: true });
  seq = 0;
});

describe("materialising the corpus", () => {
  it("writes one file per chat, one message per line, with the event id on it", () => {
    addChannel("ch-1", "Weekend lunches", "group");
    const id = addEvent("ch-1", "booked oye kake");
    addEvent("ch-1", "🙏", { kind: "reaction" });

    const refresh = refreshCorpus();
    expect(refresh.channels).toBe(1);
    expect(refresh.messages).toBe(1); // the reaction is not a message
    expect(refresh.relativePath).toBe("corpus/");

    const file = corpusFiles()[0];
    expect(file).toMatch(/^weekend-lunches--[0-9a-f]{8}\.md$/);
    const body = read(file);
    expect(body).toContain("# Weekend lunches");
    expect(body).toContain("chat_id: ch-1");
    expect(body).toContain(`[evt ${id}]`);
    expect(body).toContain("booked oye kake");
    expect(body).not.toContain("🙏");
  });

  it("flattens a multi-line message so one message is one grep hit", () => {
    addChannel("ch-1", "Weekend lunches", "group");
    addEvent("ch-1", "Hey!\nI have made a booking on 02 Aug 2026\nfor 4 guest(s)");

    refreshCorpus();
    const lines = read(corpusFiles()[0]).split("\n").filter((l) => l.startsWith("[evt "));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Hey! I have made a booking on 02 Aug 2026 for 4 guest(s)");
  });

  it("writes nothing at all when nothing has been imported", () => {
    const refresh = refreshCorpus();
    expect(refresh.channels).toBe(0);
    expect(existsSync(corpusRoot())).toBe(false);
  });

  it("lists every chat in a README the model can start from", () => {
    addChannel("ch-1", "Weekend lunches", "group");
    addChannel("ch-2", "Mummy");
    addEvent("ch-1", "hi");
    addEvent("ch-2", "beta khana khaya");

    refreshCorpus();
    const readme = read("README.md");
    expect(readme).toContain("| Weekend lunches | 1 |");
    expect(readme).toContain("| Mummy | 1 |");
    expect(readme).toContain("[evt <event id>]");
  });
});

describe("incremental", () => {
  it("rewrites only the chat that moved", () => {
    addChannel("ch-1", "One");
    addChannel("ch-2", "Two");
    addEvent("ch-1", "first");
    addEvent("ch-2", "second");
    expect(refreshCorpus().rewritten).toBe(2);

    resetCorpusCacheForTests();
    expect(refreshCorpus().rewritten).toBe(0);

    addEvent("ch-2", "third");
    resetCorpusCacheForTests();
    const refresh = refreshCorpus();
    expect(refresh.rewritten).toBe(1);
    expect(read(corpusFiles()[1])).toContain("third");
  });

  it("rewrites when a transcript lands on a message that was already written", () => {
    addChannel("ch-1", "One");
    const id = addEvent("ch-1", "");
    refreshCorpus();
    expect(read(corpusFiles()[0])).not.toContain("shaam paanch baje");

    // The fingerprint counts characters, not rows, so a late transcript — which
    // changes no count and no rowid — still invalidates the file.
    getDb().prepare(`UPDATE events SET transcript = ? WHERE id = ?`).run(
      "Haan bhai, kal shaam paanch baje ghar aa jaunga.",
      id,
    );
    resetCorpusCacheForTests();
    expect(refreshCorpus().rewritten).toBe(1);
    expect(read(corpusFiles()[0])).toContain("shaam paanch baje");
  });

  it("rewrites everything when the line format itself has moved on", () => {
    addChannel("ch-1", "One");
    addEvent("ch-1", "first");
    expect(refreshCorpus().rewritten).toBe(1);

    // A corpus written by an older worker: same messages, older rendering. The
    // fingerprint cannot see that — it counts rows and chars of the columns —
    // so the manifest version is what invalidates it.
    const manifest = join(corpusRoot(), ".state.json");
    const stored = JSON.parse(readFileSync(manifest, "utf8"));
    writeFileSync(manifest, JSON.stringify({ ...stored, version: stored.version - 1 }));

    resetCorpusCacheForTests();
    expect(refreshCorpus().rewritten).toBe(1);
  });

  it("does not touch the manifest on a turn where nothing changed", () => {
    addChannel("ch-1", "One");
    addEvent("ch-1", "first");
    refreshCorpus();
    const before = statSync(join(corpusRoot(), ".state.json")).mtimeMs;

    resetCorpusCacheForTests();
    refreshCorpus();
    expect(statSync(join(corpusRoot(), ".state.json")).mtimeMs).toBe(before);
  });

  it("collapses two refreshes inside the throttle window", () => {
    addChannel("ch-1", "One");
    addEvent("ch-1", "first");
    expect(refreshCorpus().rewritten).toBe(1);

    addEvent("ch-1", "second");
    const second = refreshCorpus(); // no reset: still inside the window
    expect(second.skipped).toBe(true);
    expect(second.rewritten).toBe(0);
  });

  it("follows a chat that gets renamed instead of leaving a stale title behind", () => {
    addChannel("ch-1", "Weekend lunches", "group");
    addEvent("ch-1", "booked oye kake");
    refreshCorpus();
    expect(corpusFiles()[0]).toMatch(/^weekend-lunches--/);

    getDb().prepare(`UPDATE channels SET name = 'Sunday lunches' WHERE id = 'ch-1'`).run();
    resetCorpusCacheForTests();
    const refresh = refreshCorpus();
    expect(refresh.rewritten).toBe(1);
    expect(refresh.removed).toBe(1);
    expect(corpusFiles()).toHaveLength(1);
    expect(corpusFiles()[0]).toMatch(/^sunday-lunches--/);
    expect(read(corpusFiles()[0])).toContain("# Sunday lunches");
  });

  it("removes the file of a chat that no longer exists", () => {
    addChannel("ch-1", "One");
    addChannel("ch-2", "Two");
    addEvent("ch-1", "first");
    addEvent("ch-2", "second");
    refreshCorpus();
    expect(corpusFiles()).toHaveLength(2);

    getDb().prepare(`DELETE FROM events WHERE channel_id = 'ch-2'`).run();
    resetCorpusCacheForTests();
    expect(refreshCorpus().removed).toBe(1);
    expect(corpusFiles()).toHaveLength(1);
  });

  it("rebuilds from scratch when the manifest is unreadable", () => {
    addChannel("ch-1", "One");
    addEvent("ch-1", "first");
    refreshCorpus();

    rmSync(join(corpusRoot(), ".state.json"));
    resetCorpusCacheForTests();
    expect(refreshCorpus().rewritten).toBe(1);
  });
});

describe("the corpus stays inside the corpus", () => {
  it("a chat named like a path is a filename, not a path", () => {
    addChannel("ch-1", "../../../.ssh/authorized_keys", "group");
    addEvent("ch-1", "hi");

    refreshCorpus();
    const files = corpusFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^ssh-authorized-keys--[0-9a-f]{8}\.md$/);
    expect(existsSync(join(tmpRoot, "brain", ".ssh"))).toBe(false);
    expect(corpusRelativePath()).toBe("corpus/");
  });

  it("two chats with the same name get their own files", () => {
    addChannel("ch-1", "Family");
    addChannel("ch-2", "Family");
    addEvent("ch-1", "one");
    addEvent("ch-2", "two");

    refreshCorpus();
    expect(corpusFiles()).toHaveLength(2);
    expect(new Set(corpusFiles()).size).toBe(2);
  });
});
