import { LM, type Pt } from "./geometry.ts";

/**
 * Builds a synthetic 478-point landmark set for a front-facing face centred
 * at (cx, cy) with forehead→chin height `h` (all normalised 0..1), optionally
 * rolled by `rollDeg` and yawed by shifting the nose.
 */
export function syntheticFace({ cx = 0.5, cy = 0.5, h = 0.4, rollDeg = 0, noseShift = 0, aspect = 1 } = {}): Pt[] {
  const pts: Pt[] = Array.from({ length: 478 }, () => ({ x: 0, y: 0 }));
  // Local coordinates in "face heights", y down; x scaled by aspect (width/height of image).
  const local: Record<number, [number, number]> = {
    [LM.forehead]: [0, -0.5],
    [LM.chin]: [0, 0.5],
    [LM.noseTip]: [noseShift, 0.06],
    [LM.leftCheek]: [-0.38, 0],
    [LM.rightCheek]: [0.38, 0],
    [LM.eyeOuterA]: [-0.28, -0.12],
    [LM.eyeInnerA]: [-0.1, -0.12],
    [LM.eyeTopA]: [-0.19, -0.15],
    [LM.eyeBottomA]: [-0.19, -0.09],
    [LM.eyeOuterB]: [0.28, -0.12],
    [LM.eyeInnerB]: [0.1, -0.12],
    [LM.eyeTopB]: [0.19, -0.15],
    [LM.eyeBottomB]: [0.19, -0.09],
    [LM.mouthLeft]: [-0.14, 0.25],
    [LM.mouthRight]: [0.14, 0.25],
    [LM.lipTop]: [0, 0.23],
    [LM.lipBottom]: [0, 0.27],
  };
  const r = (rollDeg * Math.PI) / 180;
  const place = ([lx, ly]: [number, number]): Pt => {
    const x = (lx * Math.cos(r) - ly * Math.sin(r)) * h;
    const y = (lx * Math.sin(r) + ly * Math.cos(r)) * h;
    return { x: cx + x / aspect, y: cy + y };
  };
  const fallback = place([0, 0]);
  for (let i = 0; i < pts.length; i++) pts[i] = local[i] ? place(local[i]) : fallback;
  return pts;
}

/** Mid-grey noisy image: well lit and "sharp" by the Laplacian metric. */
export function texturedImage(width: number, height: number, { mean = 130, amp = 60, seed = 1 } = {}) {
  const data = new Uint8ClampedArray(width * height * 4);
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < width * height; i++) {
    const v = mean + (rnd() - 0.5) * amp * 2;
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

export function flatImage(width: number, height: number, v: number) {
  const data = new Uint8ClampedArray(width * height * 4).fill(v);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { data, width, height };
}
