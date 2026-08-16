// ===========================================================================
// Bridge normal forms (arch §11.2, build item 2.4). Every bridge kind has one
// spelling; these pin it, including the two thresholds that are measurements
// rather than string equality.
// ===========================================================================

import { describe, expect, it } from "vitest";

import {
  ATTENDEE_JACCARD_MIN,
  GEO_MAX_METERS,
  GEO_MAX_MS,
  geoTimeFires,
  geoTimeValue,
  geohash,
  haversineMeters,
  intersection,
  jaccard,
  normaliseAttendeeSet,
  normaliseEmail,
  normaliseFileId,
  normaliseMediaWorkId,
  normaliseOrderId,
  normalisePhone,
  normaliseUrl,
} from "./normalise.js";

describe("normaliseUrl", () => {
  it("lowercases the host, drops www, the scheme and a default port", () => {
    expect(normaliseUrl("HTTP://WWW.Site0.com:80/X")).toBe("site0.com/X");
    expect(normaliseUrl("https://site0.com/x")).toBe("site0.com/x");
  });

  it("strips tracking params and keeps the identifying ones", () => {
    expect(normaliseUrl("https://site0.com/x?utm_source=wa&utm_campaign=aug&id=7")).toBe("site0.com/x?id=7");
    expect(normaliseUrl("https://site0.com/x?fbclid=abc&gclid=d")).toBe("site0.com/x");
  });

  it("sorts the surviving query so param order stops mattering", () => {
    expect(normaliseUrl("https://site0.com/x?b=2&a=1")).toBe(normaliseUrl("https://site0.com/x?a=1&b=2"));
  });

  it("drops an anchor but keeps a hashbang route", () => {
    expect(normaliseUrl("https://site0.com/x#reviews")).toBe("site0.com/x");
    expect(normaliseUrl("https://site0.com/x#!/villa/7")).toBe("site0.com/x#!/villa/7");
  });

  it("drops a trailing slash and trailing sentence punctuation", () => {
    expect(normaliseUrl("https://site0.com/x/")).toBe("site0.com/x");
    expect(normaliseUrl("https://site0.com/x).")).toBe("site0.com/x");
  });

  it("resolves a shortlink from a learned expansion, never from the network", () => {
    const expansions = new Map([["https://bit.ly/goa7", "https://www.site0.com/x?utm_source=sms"]]);
    expect(normaliseUrl("https://bit.ly/goa7", { expansions })).toBe("site0.com/x");
    // Unknown expansion: it normalises to ITSELF rather than inventing a target.
    expect(normaliseUrl("https://bit.ly/unknown")).toBe("bit.ly/unknown");
  });

  it("expands youtu.be without any lookup at all", () => {
    expect(normaliseUrl("https://youtu.be/dQw4w9WgXcQ")).toBe("youtube.com/watch?v=dQw4w9WgXcQ");
    expect(normaliseUrl("https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share")).toBe(
      "youtube.com/watch?v=dQw4w9WgXcQ",
    );
  });

  it("refuses anything that is not http(s)", () => {
    expect(normaliseUrl("mailto:a@b.com")).toBeNull();
    expect(normaliseUrl("")).toBeNull();
  });
});

describe("normaliseEmail", () => {
  it("lowercases, and folds gmail dots and plus tags", () => {
    expect(normaliseEmail("Rohan.Malhotra+trips@Gmail.com")).toBe("rohanmalhotra@gmail.com");
    expect(normaliseEmail("rohanmalhotra@googlemail.com")).toBe("rohanmalhotra@gmail.com");
  });

  it("leaves dots alone outside the gmail family", () => {
    expect(normaliseEmail("a.b@corp.in")).toBe("a.b@corp.in");
  });

  it("rejects a non-address", () => {
    expect(normaliseEmail("not-an-email")).toBeNull();
    expect(normaliseEmail("@nope.com")).toBeNull();
  });
});

describe("normalisePhone", () => {
  it("renders E.164 from the spellings a human types", () => {
    expect(normalisePhone("+91 98765 43210")).toBe("+919876543210");
    expect(normalisePhone("9876543210")).toBe("+919876543210");
    expect(normalisePhone("098765-43210")).toBe("+919876543210");
    expect(normalisePhone("+1 (415) 555-0134")).toBe("+14155550134");
  });

  it("refuses a bare number that is not a whole national number", () => {
    expect(normalisePhone("12345")).toBeNull();
  });
});

describe("opaque ids", () => {
  it("prefixes an order id with a slugged vendor and keeps the id verbatim", () => {
    expect(normaliseOrderId("Make My Trip", "nf28123456789012")).toBe("makemytrip:NF28123456789012");
    expect(normaliseOrderId(null, "407-1234567-1234567")).toBe("generic:407-1234567-1234567");
  });

  it("prefixes a file id with its provider and preserves its case", () => {
    expect(normaliseFileId("gdrive", "1AbCdEfGhIjK")).toBe("gdrive:1AbCdEfGhIjK");
    expect(normaliseFileId("gdrive", "short")).toBeNull();
  });

  it("passes a media_work entity id through untouched", () => {
    expect(normaliseMediaWorkId(" mw_inception ")).toBe("mw_inception");
  });
});

describe("attendee sets", () => {
  it("sorts and de-duplicates", () => {
    expect(normaliseAttendeeSet(["b", "a", "b", " "])).toBe("a+b");
    expect(normaliseAttendeeSet([])).toBeNull();
  });

  it("scores Jaccard, and 0.6 is the bar", () => {
    expect(jaccard(["a", "b", "c"], ["a", "b", "c"])).toBe(1);
    expect(jaccard(["a", "b", "c"], ["a", "b", "d"])).toBeCloseTo(0.5, 6);
    expect(jaccard(["a", "b", "c"], [])).toBe(0);
    expect(ATTENDEE_JACCARD_MIN).toBe(0.6);
  });

  it("hands back the shared members, sorted", () => {
    expect(intersection(["c", "a", "b"], ["b", "c"])).toEqual(["b", "c"]);
  });
});

describe("geo_time", () => {
  const bandra = { lat: 19.0596, lon: 72.8295 };

  it("geohashes to six characters", () => {
    expect(geohash(bandra.lat, bandra.lon)).toHaveLength(6);
    expect(geohash(bandra.lat, bandra.lon)).toBe(geohash(bandra.lat + 0.00001, bandra.lon));
  });

  it("measures real metres", () => {
    // ~150 m north.
    const near = { lat: bandra.lat + 0.00135, lon: bandra.lon };
    expect(haversineMeters(bandra, near)).toBeGreaterThan(130);
    expect(haversineMeters(bandra, near)).toBeLessThan(170);
  });

  it("fires only within 200 m AND 45 min", () => {
    const t0 = Date.parse("2026-08-13T13:00:00.000Z");
    const near = { lat: bandra.lat + 0.00135, lon: bandra.lon };
    const far = { lat: bandra.lat + 0.00225, lon: bandra.lon }; // ~250 m
    expect(geoTimeFires({ ...bandra, tsMs: t0 }, { ...near, tsMs: t0 + 30 * 60_000 })).toBe(true);
    expect(geoTimeFires({ ...bandra, tsMs: t0 }, { ...far, tsMs: t0 + 30 * 60_000 })).toBe(false);
    expect(geoTimeFires({ ...bandra, tsMs: t0 }, { ...near, tsMs: t0 + 60 * 60_000 })).toBe(false);
    expect(GEO_MAX_METERS).toBe(200);
    expect(GEO_MAX_MS).toBe(45 * 60_000);
  });

  it("stamps the normal form with a geohash and a time bucket", () => {
    const value = geoTimeValue(bandra.lat, bandra.lon, Date.parse("2026-08-13T13:00:00.000Z"));
    expect(value).toMatch(/^[0-9b-z]{6}@\d+$/);
  });
});
