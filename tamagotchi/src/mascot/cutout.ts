import type { Rect, RGBAImage } from "../face/pixels.ts";

// Background removal for the generated mascot. The prompt asks for a flat
// pure-white background, so a colour-distance flood fill from the image border
// is enough — no 40 MB segmentation model needed. Holes enclosed by the body
// (between an arm and the torso) are removed too, but only when they match the
// background almost exactly and are large, so white eye highlights survive.

export interface CutoutOptions {
  /** Colour distance treated as background when connected to the border. */
  hard?: number;
  /** Stricter distance for enclosed holes. */
  hole?: number;
  /** Minimum enclosed-hole size, as a fraction of the image. */
  minHole?: number;
}

export interface CutoutResult {
  image: RGBAImage;
  /** Bounding box of visible pixels, or null if nothing is left. */
  bbox: Rect | null;
  /** Fraction of pixels made transparent. */
  removed: number;
  /** False when the result looks wrong (keep the original instead). */
  ok: boolean;
  background: [number, number, number];
}

export function removeBackground(src: RGBAImage, opts: CutoutOptions = {}): CutoutResult {
  const hard = opts.hard ?? 42;
  const hole = opts.hole ?? 14;
  const minHole = opts.minHole ?? 0.004;
  const { width: w, height: h } = src;
  const n = w * h;
  const data = new Uint8ClampedArray(src.data);
  const bg = borderMedian(src);

  const dist = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    dist[i] = Math.hypot(data[o] - bg[0], data[o + 1] - bg[1], data[o + 2] - bg[2]);
  }

  // 0 = subject, 1 = background
  const isBg = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qh = 0,
    qt = 0;
  const seed = (i: number) => {
    if (!isBg[i] && dist[i] < hard) {
      isBg[i] = 1;
      queue[qt++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  const flood = (limit: number, mark: Uint8Array, value: number) => {
    while (qh < qt) {
      const i = queue[qh++];
      const x = i % w;
      const y = (i - x) / w;
      if (x > 0) visit(i - 1);
      if (x < w - 1) visit(i + 1);
      if (y > 0) visit(i - w);
      if (y < h - 1) visit(i + w);
    }
    function visit(j: number) {
      if (!mark[j] && dist[j] < limit) {
        mark[j] = value;
        queue[qt++] = j;
      }
    }
  };
  flood(hard, isBg, 1);

  // Enclosed holes: components of near-exact background colour.
  const seen = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (isBg[i] || seen[i] || dist[i] >= hole) continue;
    qh = qt = 0;
    seen[i] = 1;
    queue[qt++] = i;
    flood(hole, seen, 1);
    // flood() left the component's indices in queue[0..qt)
    if (qt >= minHole * n) for (let k = 0; k < qt; k++) isBg[queue[k]] = 1;
  }

  let removed = 0;
  let minX = w,
    minY = h,
    maxX = -1,
    maxY = -1;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (isBg[i]) {
      data[o + 3] = 0;
      removed++;
      continue;
    }
    const x = i % w;
    const y = (i - x) / w;
    const touchesBg = (x > 0 && isBg[i - 1]) || (x < w - 1 && isBg[i + 1]) || (y > 0 && isBg[i - w]) || (y < h - 1 && isBg[i + w]);
    if (touchesBg) {
      // Anti-aliased edge pixel = alpha·subject + (1-alpha)·background. The
      // most "solid" neighbour tells us the subject colour, so alpha is the
      // ratio of distances from the background; then un-mix the background
      // so a white halo doesn't show on the coloured pet screen.
      let solid = dist[i];
      if (x > 0 && !isBg[i - 1]) solid = Math.max(solid, dist[i - 1]);
      if (x < w - 1 && !isBg[i + 1]) solid = Math.max(solid, dist[i + 1]);
      if (y > 0 && !isBg[i - w]) solid = Math.max(solid, dist[i - w]);
      if (y < h - 1 && !isBg[i + w]) solid = Math.max(solid, dist[i + w]);
      if (dist[i] < solid * 0.92) {
        const a = Math.max(0.12, dist[i] / solid);
        for (let c = 0; c < 3; c++) data[o + c] = Math.round((data[o + c] - (1 - a) * bg[c]) / a);
        data[o + 3] = Math.round(a * 255);
      }
    }
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const frac = removed / n;
  const bbox = maxX >= 0 ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null;
  // Too little removed → background wasn't flat; too much → subject got eaten.
  const ok = bbox !== null && frac > 0.15 && frac < 0.93 && bbox.h > h * 0.3;
  return { image: { data, width: w, height: h }, bbox, removed: frac, ok, background: bg };
}

function borderMedian(img: RGBAImage): [number, number, number] {
  const { width: w, height: h, data } = img;
  const ch: number[][] = [[], [], []];
  const take = (x: number, y: number) => {
    const o = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) ch[c].push(data[o + c]);
  };
  const step = Math.max(1, Math.floor(Math.min(w, h) / 64));
  for (let x = 0; x < w; x += step) {
    take(x, 0);
    take(x, h - 1);
  }
  for (let y = 0; y < h; y += step) {
    take(0, y);
    take(w - 1, y);
  }
  return ch.map((v) => v.sort((a, b) => a - b)[v.length >> 1]) as [number, number, number];
}
