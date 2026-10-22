import { describe, expect, it } from "vitest";
import { DEFAULT_SELECTION } from "../shared/options.ts";
import { buildMascotPrompt } from "./prompt.ts";

describe("buildMascotPrompt", () => {
  const prompt = buildMascotPrompt({ ...DEFAULT_SELECTION, style: ["pixel"], accessories: ["goggles", "crown"], power: ["ice"] });

  it("puts likeness preservation before styling", () => {
    expect(prompt.indexOf("LIKENESS")).toBeGreaterThan(-1);
    expect(prompt.indexOf("LIKENESS")).toBeLessThan(prompt.indexOf("STYLE:"));
    expect(prompt).toMatch(/hairstyle/);
    expect(prompt).toMatch(/glasses/);
  });

  it("asks for a rig-friendly pose and a flat white background", () => {
    expect(prompt).toMatch(/front view/);
    expect(prompt).toMatch(/mouth closed/);
    expect(prompt).toMatch(/pure white \(#FFFFFF\)/);
  });

  it("includes exactly the chosen options", () => {
    expect(prompt).toMatch(/pixel art/);
    expect(prompt).toMatch(/goggles/);
    expect(prompt).toMatch(/tiny tilted crown/);
    expect(prompt).toMatch(/snowflake/);
    expect(prompt).not.toMatch(/cape/);
  });

  it("omits the accessories clause when none are picked", () => {
    expect(buildMascotPrompt({ ...DEFAULT_SELECTION, accessories: [] })).not.toMatch(/Accessories:/);
  });
});

describe("compact prompt (local models)", () => {
  const compact = buildMascotPrompt(DEFAULT_SELECTION, { compact: true });
  it("stays short enough for a 512-token text encoder but keeps the priorities", () => {
    expect(compact.split(/\s+/).length).toBeLessThan(170);
    expect(compact.indexOf("exact face")).toBeLessThan(compact.indexOf("Style:"));
    expect(compact).toMatch(/white background/);
    expect(compact).toMatch(/cape/);
  });
});
