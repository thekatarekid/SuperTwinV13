// ===========================================================================
// V13 envelope builder tests (P0.6; spec §6.1, §5.3). Pure — no DB, no daemon.
// ===========================================================================

import { describe, expect, it } from "vitest";

import type { SourceEvent } from "../types.js";
import {
  ageBand,
  buildWhatsAppEnvelope,
  contentHash,
  ulid,
} from "./envelope.js";

const NOW = Date.parse("2026-08-25T19:42:10.000Z");
const DAY = 24 * 60 * 60 * 1000;

function evt(over: Partial<SourceEvent> = {}): SourceEvent {
  return {
    external_id: "1602@g.us/MSG1",
    stream_ext_id: "1602@g.us",
    actor_ext_id: "rohan@s.whatsapp.net",
    ts: new Date(NOW - 60_000).toISOString(),
    kind: "message",
    text: "guys lets lock goa 18-21 dec",
    from_me: false,
    ...over,
  };
}

describe("ageBand (spec §5.3: A 0–30d · B 1–6mo · C 6mo–2y · D 2y+)", () => {
  it("assigns the four bands by event age", () => {
    expect(ageBand(NOW - 1 * DAY, NOW)).toBe("A");
    expect(ageBand(NOW - 30 * DAY, NOW)).toBe("A");
    expect(ageBand(NOW - 45 * DAY, NOW)).toBe("B");
    expect(ageBand(NOW - 180 * DAY, NOW)).toBe("B");
    expect(ageBand(NOW - 200 * DAY, NOW)).toBe("C");
    expect(ageBand(NOW - 700 * DAY, NOW)).toBe("C");
    expect(ageBand(NOW - 800 * DAY, NOW)).toBe("D");
  });

  it("clamps a future ts into band A rather than going negative", () => {
    expect(ageBand(NOW + DAY, NOW)).toBe("A");
  });
});

describe("ulid", () => {
  it("is 26 chars of Crockford base32 and time-ordered", () => {
    const a = ulid(NOW);
    const b = ulid(NOW + 60_000);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(b).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    // The 10-char time prefix sorts by time.
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
  });

  it("is unique across calls at the same ms", () => {
    const seen = new Set(Array.from({ length: 200 }, () => ulid(NOW)));
    expect(seen.size).toBe(200);
  });
});

describe("buildWhatsAppEnvelope", () => {
  it("builds the spec §6.1 shape: roles from roster, receiver *audience", () => {
    const env = buildWhatsAppEnvelope(evt(), {
      selfExtId: "me@s.whatsapp.net",
      roster: ["rohan@s.whatsapp.net", "tanvi@s.whatsapp.net", "karan@s.whatsapp.net"],
      nowMs: NOW,
    });
    expect(env.source).toBe("wa");
    expect(env.kind).toBe("wa.message");
    expect(env.origin).toBe("live");
    expect(env.age_band).toBe("A");
    expect(env.stream_key).toBe("wa:1602@g.us"); // S3.4: wa:<jid>
    expect(env.actor).toBe("rohan@s.whatsapp.net");
    expect(env.roles.sender).toBe("rohan@s.whatsapp.net");
    expect(env.roles.audience).toEqual([
      "self",
      "rohan@s.whatsapp.net",
      "tanvi@s.whatsapp.net",
      "karan@s.whatsapp.net",
    ]);
    expect(env.roles.receiver).toEqual(["*audience"]);
    expect(env.roles.mentions).toEqual([]);
    expect(env.payload.text).toBe("guys lets lock goa 18-21 dec");
    expect(env.content_hash).toHaveLength(64);
    expect(env.blob_refs).toEqual([]);
  });

  it("maps the self jid to 'self' everywhere it appears", () => {
    const env = buildWhatsAppEnvelope(
      evt({
        from_me: true,
        actor_ext_id: "me@s.whatsapp.net",
        mentioned_ext_ids: ["me@s.whatsapp.net", "tanvi@s.whatsapp.net"],
      }),
      {
        selfExtId: "me@s.whatsapp.net",
        roster: ["tanvi@s.whatsapp.net", "me@s.whatsapp.net"],
        nowMs: NOW,
      },
    );
    expect(env.actor).toBe("self");
    expect(env.roles.sender).toBe("self");
    // Self appears once even though it is in the roster too.
    expect(env.roles.audience).toEqual(["self", "tanvi@s.whatsapp.net"]);
    expect(env.roles.mentions).toEqual(["self", "tanvi@s.whatsapp.net"]);
  });

  it("mentions are structural: taken from mentioned_ext_ids, never parsed", () => {
    const env = buildWhatsAppEnvelope(
      evt({ text: "@karan you in?", mentioned_ext_ids: ["karan@s.whatsapp.net"] }),
      { nowMs: NOW },
    );
    expect(env.roles.mentions).toEqual(["karan@s.whatsapp.net"]);
  });

  it("carries a structural reply marker for a quoted reply", () => {
    const env = buildWhatsAppEnvelope(
      evt({
        reply_to: {
          external_id: "1602@g.us/MSG0",
          text: "flights are cheap rn",
          actor_ext_id: "tanvi@s.whatsapp.net",
        },
      }),
      { selfExtId: "me@s.whatsapp.net", nowMs: NOW },
    );
    expect(env.payload.reply_to).toEqual({
      external_id: "1602@g.us/MSG0",
      text: "flights are cheap rn",
      actor: "tanvi@s.whatsapp.net",
    });
  });

  it("carries the reaction target for kind:reaction", () => {
    const env = buildWhatsAppEnvelope(
      evt({ kind: "reaction", text: "🔥", reply_to_external_id: "1602@g.us/MSG0" }),
      { nowMs: NOW },
    );
    expect(env.kind).toBe("wa.reaction");
    expect(env.payload.reaction_to).toBe("1602@g.us/MSG0");
  });

  it("marks backfill origin + older age bands for historical events", () => {
    const env = buildWhatsAppEnvelope(
      evt({ is_historical: true, ts: new Date(NOW - 400 * DAY).toISOString() }),
      { nowMs: NOW },
    );
    expect(env.origin).toBe("backfill");
    expect(env.age_band).toBe("C");
  });

  it("collects media paths into blob_refs", () => {
    const env = buildWhatsAppEnvelope(
      evt({
        kind: "image",
        media: { path: "/m/a.jpg", thumb_path: "/m/a.thumb.jpg" },
      }),
      { nowMs: NOW },
    );
    expect(env.blob_refs).toEqual(["/m/a.jpg", "/m/a.thumb.jpg"]);
    expect(env.kind).toBe("wa.image");
  });

  it("content_hash is stable for the same event and differs across events", () => {
    expect(contentHash(evt())).toBe(contentHash(evt()));
    expect(contentHash(evt())).not.toBe(
      contentHash(evt({ external_id: "1602@g.us/MSG2" })),
    );
  });

  it("two builds of the same event share content_hash but not id", () => {
    const a = buildWhatsAppEnvelope(evt(), { nowMs: NOW });
    const b = buildWhatsAppEnvelope(evt(), { nowMs: NOW });
    expect(a.content_hash).toBe(b.content_hash);
    expect(a.id).not.toBe(b.id);
  });
});
