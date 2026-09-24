// Small pixel utilities used by the photo quality checks. Pure functions over
// RGBA buffers so they run (and are tested) without a canvas.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RGBAImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Grayscale (Rec. 601 luma) of a rect, nearest-neighbour resampled to `outW` wide. */
export function grayPatch(img: RGBAImage, rect: Rect, outW = 128): { gray: Float32Array; w: number; h: number } {
  const r = clampRect(rect, img.width, img.height);
  const w = Math.max(1, Math.min(outW, Math.round(r.w)));
  const h = Math.max(1, Math.round((r.h / r.w) * w));
  const gray = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(r.y + ((y + 0.5) * r.h) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(r.x + ((x + 0.5) * r.w) / w));
      const i = (sy * img.width + sx) * 4;
      gray[y * w + x] = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
    }
  }
  return { gray, w, h };
}

export function meanStd(values: Float32Array): { mean: number; std: number } {
  if (!values.length) return { mean: 0, std: 0 };
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / values.length;
  let sq = 0;
  for (const v of values) sq += (v - mean) ** 2;
  return { mean, std: Math.sqrt(sq / values.length) };
}

/** Variance of the 4-neighbour Laplacian — the classic cheap blur metric. */
export function laplacianVariance(gray: Float32Array, w: number, h: number): number {
  if (w < 3 || h < 3) return 0;
  const out = new Float32Array((w - 2) * (h - 2));
  let k = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      out[k++] = gray[i - w] + gray[i + w] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
    }
  }
  return meanStd(out).std ** 2;
}

export function clampRect(r: Rect, width: number, height: number): Rect {
  const x = Math.max(0, Math.min(width - 1, r.x));
  const y = Math.max(0, Math.min(height - 1, r.y));
  return { x, y, w: Math.max(1, Math.min(width - x, r.w)), h: Math.max(1, Math.min(height - y, r.h)) };
}
