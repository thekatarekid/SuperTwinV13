import { describe, expect, it } from "vitest";
import { planCrop } from "./crop.ts";
import { faceGeometry } from "./geometry.ts";
import { assessPhoto } from "./quality.ts";
import { flatImage, syntheticFace, texturedImage } from "./testFace.ts";

const W = 640;
const H = 480;
const aspect = W / H;
const img = texturedImage(W, H);
const ids = (a: ReturnType<typeof assessPhoto>) => a.checks.filter((c) => !c.ok).map((c) => c.id);

describe("assessPhoto", () => {
  it("passes a centred, frontal, well-lit, sharp face", () => {
    const a = assessPhoto({ faces: [syntheticFace({ aspect })], image: img, blink: { left: 0.1, right: 0.1 }, mode: "webcam" });
    expect(ids(a)).toEqual([]);
    expect(a.perfect).toBe(true);
    expect(a.usable).toBe(true);
    expect(a.score).toBeGreaterThan(0.7);
  });

  it("blocks when there is no face or more than one", () => {
    expect(assessPhoto({ faces: [], image: img, mode: "upload" }).usable).toBe(false);
    const two = assessPhoto({ faces: [syntheticFace({ aspect, cx: 0.3 }), syntheticFace({ aspect, cx: 0.7 })], image: img, mode: "upload" });
    expect(two.usable).toBe(false);
    expect(ids(two)).toContain("single");
  });

  it("blocks a face too small to keep likeness", () => {
    const a = assessPhoto({ faces: [syntheticFace({ aspect, h: 0.15 })], image: img, mode: "upload" });
    expect(a.usable).toBe(false);
    expect(ids(a)).toContain("size");
  });

  it("warns (but allows) off-centre, turned, dark, blurry or eyes-closed faces", () => {
    expect(ids(assessPhoto({ faces: [syntheticFace({ aspect, cx: 0.8 })], image: img, mode: "webcam" }))).toContain("centered");
    const turned = assessPhoto({ faces: [syntheticFace({ aspect, noseShift: 0.2 })], image: img, mode: "upload" });
    expect(ids(turned)).toContain("angle");
    expect(turned.usable).toBe(true);
    expect(ids(assessPhoto({ faces: [syntheticFace({ aspect })], image: texturedImage(W, H, { mean: 40, amp: 20 }), mode: "upload" }))).toContain("light");
    const blurry = assessPhoto({ faces: [syntheticFace({ aspect })], image: flatImage(W, H, 128), mode: "upload" });
    expect(ids(blurry)).toEqual(expect.arrayContaining(["sharp", "light"])); // flat = no contrast either
    expect(ids(assessPhoto({ faces: [syntheticFace({ aspect })], image: img, blink: { left: 0.9, right: 0.8 }, mode: "upload" }))).toContain("eyes");
  });

  it("does not flag a tilted head — the crop levels it", () => {
    const a = assessPhoto({ faces: [syntheticFace({ aspect, rollDeg: 15 })], image: img, mode: "upload" });
    expect(ids(a)).not.toContain("angle");
  });
});

describe("faceGeometry + planCrop", () => {
  it("measures roll and levels it in the crop", () => {
    const geo = faceGeometry(syntheticFace({ aspect, rollDeg: 20 }), W, H);
    expect(geo.rollDeg).toBeCloseTo(20, 0);
    expect(Math.abs(geo.yaw)).toBeLessThan(0.02);
    const plan = planCrop(geo);
    expect((plan.angle * 180) / Math.PI).toBeCloseTo(-20, 0);
  });

  it("frames head and shoulders with the face ~48% of the crop, lifted for hair", () => {
    const geo = faceGeometry(syntheticFace({ aspect }), W, H);
    const plan = planCrop(geo);
    expect(geo.faceHeight / plan.side).toBeCloseTo(0.476, 2);
    expect(plan.cy).toBeLessThan(H / 2); // centre moved up toward the hair
    expect(plan.cx).toBeCloseTo(W / 2, 3);
  });
});
