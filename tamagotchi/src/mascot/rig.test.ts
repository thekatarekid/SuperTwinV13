import { describe, expect, it } from "vitest";
import { syntheticFace } from "../face/testFace.ts";
import { estimateArms, estimateRig, rigFromLandmarks, rigLooksValid } from "./rig.ts";

const bbox = { x: 0.25, y: 0.09, w: 0.5, h: 0.88 };

describe("rig", () => {
  it("estimates a valid chibi rig from the sprite bounds", () => {
    const rig = estimateRig(bbox);
    expect(rig.source).toBe("estimate");
    expect(rigLooksValid(rig, bbox)).toBe(true);
    expect(rig.eyes[0].x).toBeLessThan(rig.eyes[1].x);
    expect(rig.mouth.y).toBeGreaterThan(rig.eyes[0].y);
    expect(rig.feetY).toBeCloseTo(0.97, 5);
  });

  it("builds a rig from landmarks on the mascot's face", () => {
    const rig = rigFromLandmarks(syntheticFace({ cx: 0.5, cy: 0.33, h: 0.3 }), 0.97);
    expect(rig.source).toBe("landmarks");
    expect(rigLooksValid(rig, bbox)).toBe(true);
    expect(rig.eyes[0].x).toBeCloseTo(0.5 - 0.19 * 0.3, 3);
    expect(rig.mouth.y).toBeCloseTo(0.33 + 0.25 * 0.3, 3);
  });

  it("rejects a nonsense fit (e.g. a 'face' found on the suit emblem)", () => {
    const rig = rigFromLandmarks(syntheticFace({ cx: 0.5, cy: 0.8, h: 0.05 }), 0.97);
    expect(rigLooksValid(rig, bbox)).toBe(false);
  });
});

describe("estimateArms", () => {
  // 200×200 mask: a torso block and two arms separated from it by a gap.
  const S = 200;
  const alpha = new Uint8Array(S * S);
  const fill = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) alpha[y * S + x] = 255;
  };
  fill(70, 100, 130, 190); // torso
  fill(52, 105, 64, 160); // left arm
  fill(136, 105, 148, 160); // right arm
  const rig = { ...estimateRig({ x: 0.2, y: 0.05, w: 0.6, h: 0.9 }), head: { x: 0.5, y: 0.3, r: 0.2 }, neckY: 0.5, feetY: 0.95 };

  it("finds shoulders at the torso edge and hands at the bottom of each arm", () => {
    const arms = estimateArms(alpha, S, rig)!;
    expect(arms).not.toBeNull();
    const [l, r] = arms;
    expect(l.sx * S).toBeCloseTo(70, 0);
    expect(r.sx * S).toBeCloseTo(129, 0);
    expect(l.hx * S).toBeCloseTo(57.5, 0);
    expect(l.hy * S).toBeGreaterThan(145);
    expect(l.r * S).toBeGreaterThan(6);
  });

  it("returns null when the arms touch the body", () => {
    const glued = new Uint8Array(S * S);
    for (let y = 100; y < 190; y++) for (let x = 52; x < 148; x++) glued[y * S + x] = 255;
    expect(estimateArms(glued, S, rig)).toBeNull();
  });
});

describe("armMask", () => {
  it("labels exactly the arm pixels (plus a thin rim), never the torso", async () => {
    const { armMask } = await import("./rig.ts");
    const S = 200;
    const alpha = new Uint8Array(S * S);
    const fill = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) alpha[y * S + x] = 255;
    };
    fill(70, 100, 130, 190);
    fill(52, 105, 64, 160);
    fill(136, 105, 148, 160);
    const rig = { ...estimateRig({ x: 0.2, y: 0.05, w: 0.6, h: 0.9 }), head: { x: 0.5, y: 0.3, r: 0.2 }, neckY: 0.5, feetY: 0.95 };
    const mask = armMask(alpha, S, rig)!;
    expect(mask[130 * S + 58]).toBe(1);
    expect(mask[130 * S + 142]).toBe(2);
    expect(mask[130 * S + 100]).toBe(0); // torso
    expect(mask[130 * S + 71]).toBe(0); // torso edge next to the gap
    expect(mask[150 * S + 30]).toBe(0); // empty background stays unlabeled
  });
});
