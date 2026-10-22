import { describe, expect, it } from "vitest";
import { removeBackground } from "./cutout.ts";

function canvas(w: number, h: number, paint: (x: number, y: number) => [number, number, number]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y);
      const o = (y * w + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  return { data, width: w, height: h };
}
const alphaAt = (img: { data: Uint8ClampedArray; width: number }, x: number, y: number) => img.data[(y * img.width + x) * 4 + 3];

describe("removeBackground", () => {
  // A red ring (with a large white hole) and a tiny white "eye highlight" inside the red.
  const W = 200;
  const img = canvas(W, W, (x, y) => {
    const d = Math.hypot(x - 100, y - 100);
    if (Math.hypot(x - 80, y - 70) < 3) return [255, 255, 255]; // highlight inside the body
    if (d < 70 && d > 25) return [210, 40, 60];
    return [255, 255, 255];
  });
  const res = removeBackground(img);

  it("removes the border-connected background and reports a sane bbox", () => {
    expect(res.ok).toBe(true);
    expect(alphaAt(res.image, 2, 2)).toBe(0);
    expect(alphaAt(res.image, 100, 40)).toBe(255); // on the ring
    expect(res.bbox!.x).toBeGreaterThanOrEqual(29);
    expect(res.bbox!.x).toBeLessThanOrEqual(31);
    expect(res.bbox!.w).toBeGreaterThanOrEqual(138);
    expect(res.bbox!.w).toBeLessThanOrEqual(142);
  });

  it("removes large enclosed holes but keeps small highlights", () => {
    expect(alphaAt(res.image, 100, 100)).toBe(0); // the big hole (like a gap between arm and body)
    expect(alphaAt(res.image, 80, 70)).toBe(255); // small highlight survives
  });

  it("gives anti-aliased edges partial alpha instead of a white halo", () => {
    const soft = canvas(100, 100, (x, y) => {
      if (x >= 40 && x < 60 && y >= 20 && y < 80) return [20, 20, 200];
      if (x === 39 && y >= 20 && y < 80) return [138, 138, 228]; // 50/50 blend with white
      return [255, 255, 255];
    });
    const r = removeBackground(soft);
    const a = alphaAt(r.image, 39, 50);
    expect(a).toBeGreaterThan(40);
    expect(a).toBeLessThan(255);
    const o = (50 * 100 + 39) * 4;
    expect(r.image.data[o + 2]).toBeGreaterThan(r.image.data[o]); // un-mixed toward the blue body
  });

  it("flags a failed cut-out when the background isn't flat", () => {
    const noisy = canvas(100, 100, (x, y) => [(x * 37 + y * 11) % 256, (x * 13) % 256, (y * 29) % 256]);
    expect(removeBackground(noisy).ok).toBe(false);
  });
});
