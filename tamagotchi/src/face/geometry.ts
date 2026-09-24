// Face geometry from MediaPipe Face Mesh landmarks (478 points, normalised
// 0..1). Only a handful of stable landmarks are used.

export interface Pt {
  x: number;
  y: number;
}

export const LM = {
  forehead: 10,
  chin: 152,
  noseTip: 1,
  leftCheek: 234, // image-left side of the face
  rightCheek: 454,
  eyeOuterA: 33, // subject's right eye, outer corner (image left)
  eyeInnerA: 133,
  eyeTopA: 159,
  eyeBottomA: 145,
  eyeOuterB: 263, // subject's left eye, outer corner (image right)
  eyeInnerB: 362,
  eyeTopB: 386,
  eyeBottomB: 374,
  mouthLeft: 61,
  mouthRight: 291,
  lipTop: 13,
  lipBottom: 14,
} as const;

export interface FaceGeometry {
  /** Face box in pixels (all landmarks). */
  box: { x: number; y: number; w: number; h: number };
  /** Eye-line tilt, degrees (positive = clockwise in the image). */
  rollDeg: number;
  /** Nose offset from the eye midpoint, in eye-distance units (0 = frontal). */
  yaw: number;
  /** Nose depth down the eye→chin line (≈0.35–0.5 when level). */
  pitch: number;
  eyeDist: number;
  /** Forehead→chin distance in pixels. */
  faceHeight: number;
  forehead: Pt;
  chin: Pt;
  eyeMid: Pt;
}

export function faceGeometry(landmarks: Pt[], width: number, height: number): FaceGeometry {
  const p = (i: number): Pt => ({ x: landmarks[i].x * width, y: landmarks[i].y * height });
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const l of landmarks) {
    minX = Math.min(minX, l.x * width);
    maxX = Math.max(maxX, l.x * width);
    minY = Math.min(minY, l.y * height);
    maxY = Math.max(maxY, l.y * height);
  }
  const a = p(LM.eyeOuterA);
  const b = p(LM.eyeOuterB);
  const nose = p(LM.noseTip);
  const chin = p(LM.chin);
  const forehead = p(LM.forehead);
  const eyeMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const eyeDist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const rollDeg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;

  // Measure yaw/pitch in the face's own (roll-corrected) frame.
  const ux = (b.x - a.x) / eyeDist;
  const uy = (b.y - a.y) / eyeDist;
  const nx = nose.x - eyeMid.x;
  const ny = nose.y - eyeMid.y;
  const yaw = (nx * ux + ny * uy) / eyeDist;
  const chinDown = (chin.x - eyeMid.x) * -uy + (chin.y - eyeMid.y) * ux;
  const noseDown = nx * -uy + ny * ux;
  const pitch = chinDown > 0 ? noseDown / chinDown : 0;

  return {
    box: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
    rollDeg,
    yaw,
    pitch,
    eyeDist,
    faceHeight: Math.hypot(chin.x - forehead.x, chin.y - forehead.y),
    forehead,
    chin,
    eyeMid,
  };
}
