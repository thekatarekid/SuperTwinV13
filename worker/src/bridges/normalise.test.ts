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
  urlTextForm,
  urlTextParams,
  contentParamRuleFor,
  URL_TEXT_MAX_CHARS,
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

// ---- url TEXT form (V6 P1 S1.4; T6-1/T6-2/T6-23; SRC-01) --------------------

describe("urlTextForm — the events.text form of a URL", () => {
  it("SRC-01: youtube keeps v,t · google keeps q · localhost:7373 keeps path · Netflix tracking dropped; survivors sorted", () => {
    expect(urlTextForm("https://www.youtube.com/watch?v=X&t=5&utm_source=nl&feature=share")).toBe(
      "https://www.youtube.com/watch?t=5&v=X",
    );
    expect(urlTextForm("https://www.google.com/search?q=tfidf&gs_lp=Egxnd3Mtd2l6&sca_esv=abc&ei=xyz&ved=2ahUKEwi&uact=5&oq=tfidf&sclient=gws-wiz-serp")).toBe(
      "https://www.google.com/search?q=tfidf",
    );
    expect(urlTextForm("http://rd3.localhost:7373/?path=%2FUsers%2Fme%2Fnotes.md&utm_campaign=x")).toBe(
      "http://rd3.localhost:7373/?path=%2FUsers%2Fme%2Fnotes.md",
    );
    expect(urlTextForm("https://www.netflix.com/watch/81234567?trackId=14170286&tctx=0%2C0%2Cabc%2CNES_1")).toBe(
      "https://www.netflix.com/watch/81234567",
    );
    expect(urlTextParams("https://www.youtube.com/watch?v=X&list=PL1&t=5")).toEqual(["list", "t", "v"]);
  });

  it("per-domain rules first: google.co.in/search, amazon.in, hotstar, youtube outside /watch falls to the denylist", () => {
    expect(urlTextForm("https://www.google.co.in/search?q=villa&udm=2&sxsrf=abc&tbm=isch")).toBe(
      "https://www.google.co.in/search?q=villa&tbm=isch&udm=2",
    );
    expect(urlTextForm("https://www.amazon.in/s?k=paperclips&crid=ABC&sprefix=pap&ref=nb_sb_noss&node=123")).toBe(
      "https://www.amazon.in/s?k=paperclips&node=123",
    );
    expect(urlTextForm("https://www.hotstar.com/in/search?search_query=cricket&from=home")).toBe(
      "https://www.hotstar.com/in/search?search_query=cricket",
    );
    // No rule for a channel page: generic denylist keeps the unknown param.
    expect(urlTextForm("https://www.youtube.com/@someone/videos?view=0&utm_source=x")).toBe(
      "https://www.youtube.com/@someone/videos?view=0",
    );
    expect(contentParamRuleFor("rd3.localhost", "/", "7373")?.name).toBe("localhost:7373/path");
    expect(contentParamRuleFor("rd3.localhost", "/", "8080")).toBeNull();
    expect(contentParamRuleFor("notlocalhost.example", "/", "7373")).toBeNull();
  });

  it("denylist, not allowlist: unknown params on unknown hosts survive; utm_*/fbclid/gclid go", () => {
    expect(urlTextForm("https://shop.example/p/123?color=red&fbclid=AbC&utm_medium=cpc&size=m")).toBe(
      "https://shop.example/p/123?color=red&size=m",
    );
  });

  it("keeps survivors' original bytes (no re-encoding), drops in-page anchors, keeps route fragments", () => {
    expect(urlTextForm("https://docs.example/a?q=a+b%20c&utm_x=1#section-3")).toBe("https://docs.example/a?q=a+b%20c");
    expect(urlTextForm("https://app.example/#/inbox?utm_source=x")).toBe("https://app.example/#/inbox?utm_source=x");
    expect(urlTextForm("https://app.example/x?utm_source=a#!/route")).toBe("https://app.example/x#!/route");
  });

  it("caps at 200 chars and fails open on anything unparseable", () => {
    const long = `https://x.example/${"a".repeat(400)}`;
    expect(urlTextForm(long)).toHaveLength(URL_TEXT_MAX_CHARS);
    expect(urlTextForm("not a url at all")).toBe("not a url at all");
    expect(urlTextForm("")).toBe("");
    expect(urlTextForm("chrome://newtab/?x=1")).toBe("chrome://newtab/?x=1");
  });

  it("the bridge key gained Netflix's trackId/tctx too", () => {
    expect(normaliseUrl("https://www.netflix.com/watch/1?trackId=2&tctx=3")).toBe("netflix.com/watch/1");
  });
});
