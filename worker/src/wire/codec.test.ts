import { describe, expect, it } from "vitest";

import { parseWire } from "./index.js";
import {
  decodeEventList,
  encodeEventList,
  fields,
  parseRecordLine,
  serialize,
  serializeRecord,
  TAG_SPECS,
  WIRE_TAGS,
  type FieldSpec,
  type TagSpec,
} from "./codec.js";
import { ENUMS, type EnumName } from "./tolerance.js";

// ---------------------------------------------------------------------------
// A generated cross-product over every tag in the closed vocabulary. Field
// value lists are small on purpose; when the full product would be huge the
// generator falls back to a cyclic covering that still exercises every value
// of every field at least once.
// ---------------------------------------------------------------------------

const DISCRIMINATOR_FIELDS = new Set(["verdict", "class"]);

function valuesFor(spec: TagSpec, field: FieldSpec, index: number): string[] {
  const isLast = index === spec.fields.length - 1;
  switch (field.type) {
    case "events":
      return ["1", "7,8,c-f", "12-15", "-"];
    case "alias":
      return ["a1", "self", "+Rahul Arora", "-"];
    case "ref":
      return ["H1", "s1", "img3", "-"];
    case "enum": {
      const codes = ENUMS[field.enum as EnumName].codes();
      const discriminating = spec.discriminate !== undefined && DISCRIMINATOR_FIELDS.has(field.name);
      return discriminating ? codes : [...codes, "-"];
    }
    case "conf":
      return ["0.95", "", "0.5", "-"];
    case "date":
      return ["2026-09-15", "{due:2026-08-08}", "-"];
    case "token":
      return field.name === "later" ? ["a", "b", "-"] : ["monthly", "current", "-"];
    case "prose":
    default:
      // Only the LAST field may carry a pipe — that is the grammar.
      return isLast
        ? ["plain text", "a | b | c", "verbatim — em dash, ünicode", "-"]
        : ["plain text", "verbatim — em dash, ünicode", "-"];
  }
}

const MAX_COMBOS_PER_VARIANT = 2048;
const CYCLIC_ROUNDS = 256;

function generateLines(spec: TagSpec): string[] {
  const lists = spec.fields.map((f, i) => valuesFor(spec, f, i));
  const total = lists.reduce((acc, l) => acc * l.length, 1);
  const lines: string[] = [];
  if (total <= MAX_COMBOS_PER_VARIANT) {
    for (let n = 0; n < total; n += 1) {
      let rest = n;
      const row = lists.map((l) => {
        const v = l[rest % l.length];
        rest = Math.floor(rest / l.length);
        return v;
      });
      lines.push([spec.tag, ...row].join("|"));
    }
  } else {
    for (let n = 0; n < CYCLIC_ROUNDS; n += 1) {
      const row = lists.map((l, j) => l[(n * (j + 1) + j) % l.length]);
      lines.push([spec.tag, ...row].join("|"));
    }
  }
  return lines;
}

function allGeneratedLines(): { lines: string[]; perTag: Map<string, number> } {
  const lines: string[] = [];
  const perTag = new Map<string, number>();
  for (const tag of WIRE_TAGS) {
    for (const spec of TAG_SPECS[tag]) {
      const generated = generateLines(spec);
      lines.push(...generated);
      perTag.set(tag, (perTag.get(tag) ?? 0) + generated.length);
    }
  }
  return { lines, perTag };
}

describe("the closed tag vocabulary (§5.3)", () => {
  it("has exactly the 23 tags", () => {
    expect(WIRE_TAGS.length).toBe(23);
    expect([...WIRE_TAGS].sort()).toEqual(
      ["M", "N", "L", "F", "P", "B", "O", "I", "R", "H", "W", "T", "Y", "Z", "G", "V", "S", "J", "D", "C", "Q", "X", "?"].sort(),
    );
  });

  it("an unknown tag is a violation, never a guess", () => {
    const out = parseRecordLine("K|1|whatever", 4, "K|1|whatever");
    expect(out).toHaveProperty("violation");
    if ("violation" in out) {
      expect(out.violation.rule).toBe("unknown_tag");
      expect(out.violation.line).toBe(4);
      expect(out.violation.raw).toBe("K|1|whatever");
    }
  });

  it("the claim kind is the tag", () => {
    for (const [tag, kind] of Object.entries({
      F: "fact",
      P: "preference",
      B: "belief",
      O: "opinion",
      I: "interest",
      R: "recommendation",
      H: "habit",
      W: "workflow",
    })) {
      const out = parseRecordLine(`${tag}|1|a1|1p|0.9|-|text`, 1, "");
      expect("record" in out && out.record.label).toBe(`claim.${kind}`);
    }
  });
});

describe("fields(raw, min, max, proseLast)", () => {
  it("trims every field, so `F | a1 | …` and `F|a1|…` are identical", () => {
    const a = fields("F | a1 | 1p", 1, 3, false);
    const b = fields("F|a1|1p", 1, 3, false);
    expect(a.fields).toEqual(b.fields);
    expect(a.tag).toBe("F");
  });

  it("re-joins the prose tail, never splits it", () => {
    const r = fields("Y|e1|a | b | c", 2, 2, true);
    expect(r.ok).toBe(true);
    expect(r.fields).toEqual(["e1", "a | b | c"]);
  });

  it("reports too_few and too_many without throwing", () => {
    expect(fields("Y|e1", 2, 2, true).reason).toBe("too_few");
    expect(fields("N|k1|Name|per|sub|surplus", 3, 4, false).reason).toBe("too_many");
    expect(fields("", 1, 2, true).reason).toBe("too_few");
  });
});

describe("event lists (§5.1, §5.2)", () => {
  it("decodes base-36 INCLUSIVE ranges", () => {
    expect(decodeEventList("12-15")).toEqual([38, 39, 40, 41]);
    expect(decodeEventList("c-f")).toEqual([12, 13, 14, 15]);
    expect(decodeEventList("7,8,12-15")).toEqual([7, 8, 38, 39, 40, 41]);
    expect(decodeEventList("1")).toEqual([1]);
  });

  it("compresses runs of ≥3 and leaves runs of 2 comma-separated", () => {
    expect(encodeEventList([1, 2])).toBe("1,2");
    expect(encodeEventList([1, 2, 3])).toBe("1-3");
    expect(encodeEventList([7, 8, 38, 39, 40, 41])).toBe("7,8,12-15");
    expect(encodeEventList([12, 13, 14, 15])).toBe("c-f");
    expect(encodeEventList([3, 1, 2, 2])).toBe("1-3");
  });

  it("refuses malformed and absurd ranges instead of exploding", () => {
    expect(decodeEventList("15-12")).toBeNull();
    expect(decodeEventList("1..3")).toBeNull();
    expect(decodeEventList("!,2")).toBeNull();
    expect(decodeEventList("1-zzzzz")).toBeNull();
    expect(decodeEventList("zzzzzzzzzzzz")).toBeNull();
  });
});

describe("prose is always last and is re-joined (§5.1)", () => {
  const cases: Array<[string, string, string]> = [
    ["Y|e1|the plan | phase two | phase three", "summary", "the plan | phase two | phase three"],
    ["F|1|a1|1p|0.9|-|she said: a|b|c", "text", "she said: a|b|c"],
    ["S|t1|dn|1|0.95|here — https://x.test/a|b", "quote", "here — https://x.test/a|b"],
    ["C|img1|menu | Margherita 480 | Diavola 560", "caption", "menu | Margherita 480 | Diavola 560"],
  ];
  for (const [line, field, expected] of cases) {
    it(`keeps the tail whole: ${line.slice(0, 24)}…`, () => {
      const out = parseRecordLine(line, 1, line);
      expect(out).toHaveProperty("record");
      if ("record" in out) {
        expect(out.record.values[field]).toBe(expected);
        expect(serializeRecord(out.record)).toBe(line);
      }
    });
  }
});

describe("field-count slack only where a tail is droppable (§5.7.4)", () => {
  it("accepts a dropped optional tail", () => {
    expect(parseRecordLine("M|1|Indiranagar|a3|0.95", 1, "")).toHaveProperty("record");
    expect(parseRecordLine("N|k1|Villa Amara|plc", 1, "")).toHaveProperty("record");
    expect(parseRecordLine("X|4,5", 1, "")).toHaveProperty("record");
  });

  it("a surplus field on a tag ending in machine fields is a violation", () => {
    for (const line of [
      "N|k1|Villa Amara|plc|resort|surplus",
      "N|k1|Villa|per|sub|extra|more",
      "N|k1|A|per|b|c",
    ]) {
      const out = parseRecordLine(line, 9, line);
      expect(out).toHaveProperty("violation");
      if ("violation" in out) {
        expect(out.violation.rule).toBe("field_count");
        expect(out.violation.line).toBe(9);
        expect(out.violation.raw).toBe(line);
      }
    }
  });

  it("too few fields is a violation too", () => {
    expect(parseRecordLine("H|1|a1|1p", 1, "")).toHaveProperty("violation");
  });
});

describe("enum, confidence and date decoding", () => {
  it("decodes drifted enum spellings to the stored long form", () => {
    const t = parseRecordLine("T|1|self|a1|ex|USER_TO_OTHER|h|d|-|-|0.9|ship", 1, "");
    expect("record" in t && t.record.values.direction).toBe("i_owe_them");
    const d = parseRecordLine("D|n1|evt|Deadline|2026-09-15|0.9|Goa trip", 1, "");
    expect("record" in d && d.record.values.cadence).toBe("one_off");
    const d2 = parseRecordLine("D|n1|evt|one_off|-|0.9|Goa trip", 1, "");
    expect("record" in d2 && d2.record.values.cadence).toBe("one_off");
    const h = parseRecordLine("H|1|a1|first_person|0.9|-|bhangra", 1, "");
    expect("record" in h && h.record.values.attribution).toBe("first_person");
  });

  it("a genuinely wrong word is a violation, not a silent default", () => {
    for (const line of [
      "H|1|a1|second_person|0.9|-|text",
      "T|1|self|a1|ex|sideways|h|d|-|-|0.9|ship",
      "D|n1|projekt|one|-|0.9|label",
    ]) {
      const out = parseRecordLine(line, 2, line);
      expect(out).toHaveProperty("violation");
      if ("violation" in out) expect(out.violation.rule).toBe("bad_enum");
    }
  });

  it("a blank enum is the model being honest", () => {
    const out = parseRecordLine("H|1|a1||0.9|-|text", 1, "");
    expect("record" in out && out.record.values.attribution).toBeNull();
  });

  it("an empty confidence field is 0.9, a dash is 0.9, a wrong number is a violation", () => {
    expect("record" in parseRecordLine("H|1|a1|1p||-|t", 1, "") && parseRecordLine("H|1|a1|1p||-|t", 1, "")).toBeTruthy();
    const empty = parseRecordLine("H|1|a1|1p||-|t", 1, "");
    expect("record" in empty && empty.record.values.confidence).toBe(0.9);
    const dash = parseRecordLine("H|1|a1|1p|-|-|t", 1, "");
    expect("record" in dash && dash.record.values.confidence).toBe(0.9);
    expect(parseRecordLine("H|1|a1|1p|1.4|-|t", 1, "")).toHaveProperty("violation");
    expect(parseRecordLine("H|1|a1|1p|high|-|t", 1, "")).toHaveProperty("violation");
  });

  it("{due:…} unwraps in a date field; {conf:…} in a due field does not", () => {
    const ok = parseRecordLine("T|1|self|a1|ex|i2t|h|d|{due:2026-08-08}|-|0.9|ship", 1, "");
    expect("record" in ok && ok.record.values.due).toBe("2026-08-08");
    const bad = parseRecordLine("T|1|self|a1|ex|i2t|h|d|{conf:0.8}|-|0.9|ship", 3, "raw");
    expect(bad).toHaveProperty("violation");
    if ("violation" in bad) expect(bad.violation.rule).toBe("token_key_mismatch");
    const bare = parseRecordLine("T|1|self|a1|ex|i2t|h|d|{due}|-|0.9|ship", 1, "");
    expect("record" in bare && bare.record.values.due).toBeNull();
    const conf = parseRecordLine("H|1|a1|1p|{conf:0.8}|-|t", 1, "");
    expect("record" in conf && conf.record.values.confidence).toBe(0.8);
  });

  it("an unparseable date is a violation — nothing is invented", () => {
    const out = parseRecordLine("T|1|self|a1|ex|i2t|h|d|next friday|-|0.9|ship", 1, "");
    expect(out).toHaveProperty("violation");
    if ("violation" in out) expect(out.violation.rule).toBe("bad_date");
  });
});

describe("variants of the same tag (§5.6)", () => {
  it("routes V by which position holds a verdict", () => {
    const arc = parseRecordLine("V|e9|jn|n1|0.97|url bridge", 1, "");
    expect("record" in arc && arc.record.variant).toBe("V.arc");
    const claim = parseRecordLine("V|A|B|ctr|a|2026-09-01|0.9|said earlier", 1, "");
    expect("record" in claim && claim.record.variant).toBe("V.claim");
    const entity = parseRecordLine("V|a1|a2|same|0.88|same group|q1,r4", 1, "");
    expect("record" in entity && entity.record.variant).toBe("V.entity");
    expect("record" in entity && entity.record.values.evidence).toBe("q1,r4");
  });

  it("routes J by its class token", () => {
    const triage = parseRecordLine("J|t1|ap|h|outward-facing", 1, "");
    expect("record" in triage && triage.record.variant).toBe("J.triage");
    const channel = parseRecordLine("J|c7|tx|0.97|own account and amount", 1, "");
    expect("record" in channel && channel.record.variant).toBe("J.channel");
  });
});

describe("round trip is byte-identical (§5.9.1)", () => {
  const { lines, perTag } = allGeneratedLines();

  it("covers every one of the 23 tags", () => {
    expect(perTag.size).toBe(23);
    for (const tag of WIRE_TAGS) expect(perTag.get(tag) ?? 0).toBeGreaterThan(0);
    expect(lines.length).toBeGreaterThan(2000);
  });

  it("accepts every generated line", () => {
    const parsed = parseWire(lines.join("\n"));
    expect(parsed.violations.map((v) => `${v.rule} ${v.raw}`)).toEqual([]);
    expect(parsed.counts.accepted).toBe(lines.length);
  });

  it("serialize(parse(serialize(x))) == serialize(x)", () => {
    const once = serialize(parseWire(lines.join("\n")).records);
    const twice = serialize(parseWire(once).records);
    expect(twice).toBe(once);
  });

  it("holds line by line as well as in bulk", () => {
    for (const line of lines) {
      const first = serialize(parseWire(line).records);
      const second = serialize(parseWire(first).records);
      expect(second).toBe(first);
    }
  });
});
