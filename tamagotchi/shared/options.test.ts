import { describe, expect, it } from "vitest";
import { ATTRIBUTES, cleanName, DEFAULT_SELECTION, parseSelection } from "./options.ts";

describe("customization catalog", () => {
  it("offers at most 5 choices per attribute, with unique ids", () => {
    for (const a of ATTRIBUTES) {
      expect(a.choices.length).toBeGreaterThan(1);
      expect(a.choices.length).toBeLessThanOrEqual(5);
      expect(new Set(a.choices.map((c) => c.id)).size).toBe(a.choices.length);
    }
  });

  it("accepts the default selection", () => {
    expect(parseSelection(DEFAULT_SELECTION)).toEqual({ ok: true, value: DEFAULT_SELECTION });
  });

  it("accepts a bare string for single-pick attributes and no accessories", () => {
    const r = parseSelection({ style: "pixel", suit: "ninja", palette: "ocean", power: "ice" });
    expect(r).toEqual({ ok: true, value: { style: ["pixel"], suit: ["ninja"], palette: ["ocean"], accessories: [], power: ["ice"] } });
  });

  it("rejects unknown ids, missing picks and too many accessories", () => {
    expect(parseSelection({ ...DEFAULT_SELECTION, style: ["oil-painting"] }).ok).toBe(false);
    expect(parseSelection({ ...DEFAULT_SELECTION, suit: [] }).ok).toBe(false);
    expect(parseSelection({ ...DEFAULT_SELECTION, accessories: ["cape", "mask", "crown"] }).ok).toBe(false);
    expect(parseSelection({ ...DEFAULT_SELECTION, power: [42] }).ok).toBe(false);
    expect(parseSelection(null).ok).toBe(false);
  });

  it("dedupes repeated ids", () => {
    const r = parseSelection({ ...DEFAULT_SELECTION, accessories: ["cape", "cape"] });
    expect(r.ok && r.value.accessories).toEqual(["cape"]);
  });

  it("cleans hero names", () => {
    expect(cleanName("  Captain   Kid!!<script>  ")).toBe("Captain Kidscript");
    expect(cleanName("Zoë-Ann O'Neil the Magnificent")).toBe("Zoë-Ann O'Neil the M");
    expect(cleanName(12)).toBe("");
  });
});
