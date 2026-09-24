import type { Pt } from "../face/geometry.ts";
import { LM } from "../face/geometry.ts";

// Where the puppet's moving parts are, in normalised sprite coordinates
// (0..1, origin top-left). Found by running the same face landmarker on the
// generated mascot; stylised faces sometimes defeat it, so there is a
// proportion-based estimate for chibi characters as a fallback.

export interface Ellipse {
  x: number;
  y: number;
  /** Half-width / half-height. */
  rx: number;
  ry: number;
}

/** A limb, from where it joins the torso to the hand (normalised coords). */
export interface Arm {
  sx: number;
  sy: number;
  hx: number;
  hy: number;
  /** Half-thickness. */
  r: number;
}

export interface Rig {
  head: { x: number; y: number; r: number };
  eyes: [Ellipse, Ellipse];
  mouth: Ellipse;
  /** Where head motion fades out. */
  neckY: number;
  /** Bottom of the feet — the pivot for breathing / squash. */
  feetY: number;
  source: "landmarks" | "estimate";
  /** Image-left and image-right arm, when they stand clear of the body. */
  arms?: [Arm, Arm] | null;
}

export function rigFromLandmarks(lm: Pt[], feetY: number): Rig {
  const p = (i: number) => lm[i];
  const eye = (outer: number, inner: number, top: number, bottom: number): Ellipse => {
    const o = p(outer),
      n = p(inner),
      t = p(top),
      b = p(bottom);
    const rx = Math.abs(o.x - n.x) / 2;
    // Cartoon eyes are taller than the landmark eyelids suggest; pad them.
    const ry = Math.max(Math.abs(b.y - t.y) / 2, rx * 0.55) * 1.5;
    return { x: (o.x + n.x) / 2, y: (t.y + b.y) / 2, rx: rx * 1.25, ry };
  };
  const forehead = p(LM.forehead);
  const chin = p(LM.chin);
  const faceH = Math.hypot(chin.x - forehead.x, chin.y - forehead.y);
  const mouthL = p(LM.mouthLeft);
  const mouthR = p(LM.mouthRight);
  const lipT = p(LM.lipTop);
  const lipB = p(LM.lipBottom);
  return {
    head: { x: (forehead.x + chin.x) / 2, y: (forehead.y + chin.y) / 2 - faceH * 0.1, r: faceH * 0.78 },
    eyes: [eye(LM.eyeOuterA, LM.eyeInnerA, LM.eyeTopA, LM.eyeBottomA), eye(LM.eyeOuterB, LM.eyeInnerB, LM.eyeTopB, LM.eyeBottomB)],
    mouth: {
      x: (mouthL.x + mouthR.x) / 2,
      y: (lipT.y + lipB.y) / 2,
      rx: Math.max(Math.abs(mouthR.x - mouthL.x) / 2, faceH * 0.08),
      ry: Math.max(Math.abs(lipB.y - lipT.y) / 2, faceH * 0.03),
    },
    neckY: chin.y + faceH * 0.08,
    feetY,
    source: "landmarks",
  };
}

/** Proportion-based guess for a front-facing chibi (head ≈ 40% of height). */
export function estimateRig(bbox: { x: number; y: number; w: number; h: number }): Rig {
  const { x, y, w, h } = bbox;
  const cx = x + w / 2;
  const headY = y + h * 0.28;
  return {
    head: { x: cx, y: headY, r: h * 0.26 },
    eyes: [
      { x: cx - h * 0.095, y: y + h * 0.3, rx: h * 0.045, ry: h * 0.055 },
      { x: cx + h * 0.095, y: y + h * 0.3, rx: h * 0.045, ry: h * 0.055 },
    ],
    mouth: { x: cx, y: y + h * 0.41, rx: h * 0.045, ry: h * 0.018 },
    neckY: y + h * 0.54,
    feetY: y + h,
    source: "estimate",
  };
}

/** Sanity-checks a landmark rig against the sprite; rejects nonsense fits. */
export function rigLooksValid(rig: Rig, bbox: { x: number; y: number; w: number; h: number }): boolean {
  const [a, b] = rig.eyes;
  const inside = (pt: { x: number; y: number }) => pt.x > bbox.x && pt.x < bbox.x + bbox.w && pt.y > bbox.y && pt.y < bbox.y + bbox.h;
  const eyeGap = Math.abs(b.x - a.x);
  return (
    inside(a) &&
    inside(b) &&
    inside(rig.mouth) &&
    a.x < b.x &&
    Math.abs(a.y - b.y) < rig.head.r * 0.35 &&
    eyeGap > rig.head.r * 0.35 &&
    rig.mouth.y > Math.max(a.y, b.y) &&
    // The head should sit in the upper part of the character.
    rig.head.y < bbox.y + bbox.h * 0.6 &&
    rig.head.r > bbox.h * 0.08
  );
}

/**
 * Finds the two arms in the cut-out's alpha mask so they can be animated as
 * separate game-style limbs. The prompt asks for "arms slightly away from the
 * body", so at chest height each side reads: torso, a transparent gap, then
 * the arm. Rows where that pattern holds give the shoulder (topmost) and the
 * hand (lowest rows). Arms glued to the body can't be separated — then this
 * returns null and the pet simply doesn't wave.
 */
export function estimateArms(alpha: Uint8ClampedArray | Uint8Array, size: number, rig: Rig): [Arm, Arm] | null {
  const found = scanArms(alpha, size, rig, null);
  return found;
}

/**
 * Per-pixel limb labels (0 = body, 1 = image-left arm, 2 = image-right arm),
 * from the same scan, grown by 2 px so each arm's anti-aliased rim moves with
 * it. The puppet uses this to move exactly the arm and nothing else.
 */
export function armMask(alpha: Uint8ClampedArray | Uint8Array, size: number, rig: Rig): Uint8Array | null {
  const mask = new Uint8Array(size * size);
  if (!scanArms(alpha, size, rig, mask)) return null;
  // Close pin-holes (rows the scan skipped), then grow over the soft rim.
  for (let pass = 0; pass < 6; pass++) {
    const src = mask.slice();
    for (let y = 1; y < size - 1; y++)
      for (let x = 1; x < size - 1; x++) {
        const i = y * size + x;
        if (src[i]) continue;
        const l = src[i - 1],
          r = src[i + 1],
          u = src[i - size],
          d = src[i + size];
        const hole = (l && l === r) || (u && u === d);
        const n = l || r || u || d;
        if (n && (hole || (pass < 5 && alpha[i] > 0))) mask[i] = n;
      }
  }
  return mask;
}

function scanArms(alpha: Uint8ClampedArray | Uint8Array, size: number, rig: Rig, mask: Uint8Array | null): [Arm, Arm] | null {
  const solid = (x: number, y: number) => x >= 0 && x < size && alpha[y * size + x] > 128;
  const cx = Math.round(rig.head.x * size);
  const neck = Math.round(rig.neckY * size);
  const feet = Math.round(rig.feetY * size);
  const bodyH = feet - neck;
  if (bodyH < size * 0.1) return null;

  const scan = (dir: 1 | -1) => {
    const rows: { y: number; torso: number; a0: number; a1: number }[] = [];
    for (let y = neck + Math.round(bodyH * 0.05); y < neck + bodyH * 0.6; y++) {
      if (!solid(cx, y)) continue;
      let x = cx;
      while (solid(x + dir, y)) x += dir; // torso edge
      const torso = x;
      let g = x + dir;
      while (g >= 0 && g < size && !solid(g, y) && Math.abs(g - torso) < size * 0.15) g += dir;
      if (!solid(g, y) || Math.abs(g - torso) < 2) continue; // no gap → no separate arm on this row
      let e = g;
      while (solid(e + dir, y)) e += dir;
      rows.push({ y, torso, a0: g, a1: e });
    }
    if (rows.length < bodyH * 0.12) return null;
    const top = rows[0];
    const tail = rows.slice(Math.floor(rows.length * 0.75));
    const hx = tail.reduce((s, r) => s + (r.a0 + r.a1) / 2, 0) / tail.length;
    const hy = tail.reduce((s, r) => s + r.y, 0) / tail.length;
    const widths = rows.map((r) => Math.abs(r.a1 - r.a0) + 1).sort((a, b) => a - b);
    const r = (widths[widths.length >> 1] / 2) * 1.35;
    return { arm: { sx: top.torso / size, sy: (top.y - r * 0.8) / size, hx: hx / size, hy: hy / size, r: r / size } as Arm, rows };
  };
  const left = scan(-1);
  const right = scan(1);
  if (!left || !right) return null;
  if (mask) {
    for (const [side, label] of [[left, 1], [right, 2]] as const) {
      for (const row of side.rows) {
        const lo = Math.min(row.a0, row.a1);
        const hi = Math.max(row.a0, row.a1);
        for (let x = lo; x <= hi; x++) mask[row.y * size + x] = label;
      }
      // Rows the scan skipped inside the arm (e.g. where the gap briefly
      // closed): copy the neighbouring row's span, limited to solid pixels.
      for (let k = 1; k < side.rows.length; k++) {
        const a = side.rows[k - 1];
        const b = side.rows[k];
        for (let y = a.y + 1; y < b.y && b.y - a.y < 12; y++) {
          const lo = Math.min(a.a0, a.a1, b.a0, b.a1);
          const hi = Math.max(a.a0, a.a1, b.a0, b.a1);
          for (let x = lo; x <= hi; x++) if (solid(x, y)) mask[y * size + x] = label;
        }
      }
      // The rounded tip below the last scanned row belongs to the arm too.
      const last = side.rows[side.rows.length - 1];
      const lo = Math.min(last.a0, last.a1);
      const hi = Math.max(last.a0, last.a1);
      for (let y = last.y + 1; y < size; y++) {
        let any = false;
        for (let x = lo; x <= hi; x++)
          if (solid(x, y) && !solid(side === left ? hi + 2 : lo - 2, y)) {
            mask[y * size + x] = label;
            any = true;
          }
        if (!any) break;
      }
    }
  }
  return [left.arm, right.arm];
}
