import { faceGeometry, type FaceGeometry, type Pt } from "./geometry.ts";
import { grayPatch, laplacianVariance, meanStd, type RGBAImage } from "./pixels.ts";

// Photo quality gate. The single biggest lever on likeness is the input: one
// sharp, well-lit, front-facing face with enough pixels. These checks run on
// every webcam frame (≈6 fps) and once on an uploaded photo.

export type CheckId = "face" | "single" | "size" | "centered" | "angle" | "light" | "sharp" | "eyes";

export interface Check {
  id: CheckId;
  ok: boolean;
  /** "block" = we won't send this photo; "warn" = allowed, but likeness may suffer. */
  severity: "block" | "warn";
  tip: string;
}

export interface Assessment {
  checks: Check[];
  /** No blocking failures — the photo may be used. */
  usable: boolean;
  /** Every check passed — webcam auto-capture fires on this. */
  perfect: boolean;
  geometry?: FaceGeometry;
  /** 0..1, used to pick the best of several webcam frames. */
  score: number;
}

export interface AssessInput {
  faces: Pt[][];
  image: RGBAImage;
  /** Eye-blink blendshape scores for the first face, if available. */
  blink?: { left: number; right: number };
  /** Live webcam framing adds a "centered" check; uploads are re-cropped anyway. */
  mode: "webcam" | "upload";
}

export const MIN_FACE_PX = 110;

export function assessPhoto({ faces, image, blink, mode }: AssessInput): Assessment {
  const checks: Check[] = [];
  const push = (id: CheckId, ok: boolean, severity: Check["severity"], tip: string) => checks.push({ id, ok, severity, tip });

  if (faces.length === 0) {
    push("face", false, "block", mode === "webcam" ? "Show your face to the camera" : "We couldn't find a face in this photo");
    return { checks, usable: false, perfect: false, score: 0 };
  }
  push("face", true, "block", "Face found");
  push("single", faces.length === 1, "block", faces.length === 1 ? "Just you" : "Only one face, please — the hero is just you");

  const geo = faceGeometry(faces[0], image.width, image.height);
  const minSide = Math.min(image.width, image.height);
  const rel = geo.faceHeight / minSide;

  if (geo.faceHeight < MIN_FACE_PX) {
    push("size", false, "block", mode === "webcam" ? "Come closer to the camera" : "Your face is too small in this photo — use a closer shot");
  } else if (mode === "webcam" && rel < 0.28) {
    push("size", false, "warn", "Come a little closer");
  } else if (rel > 0.8) {
    push("size", false, "warn", "Move back a bit so your hair fits");
  } else {
    push("size", true, "warn", "Good distance");
  }

  if (mode === "webcam") {
    const cx = geo.box.x + geo.box.w / 2;
    const cy = geo.box.y + geo.box.h / 2;
    const off = Math.max(Math.abs(cx / image.width - 0.5), Math.abs(cy / image.height - 0.5));
    push("centered", off < 0.18, "warn", off < 0.18 ? "Nicely centered" : "Center your face in the oval");
  }

  const frontal = Math.abs(geo.yaw) < 0.2 && geo.pitch > 0.24 && geo.pitch < 0.62 && Math.abs(geo.rollDeg) < 30;
  push("angle", frontal, "warn", frontal ? "Facing forward" : "Look straight at the camera");

  const patch = grayPatch(image, geo.box, 128);
  const { mean, std } = meanStd(patch.gray);
  let lightTip = "Good light";
  if (mean < 70) lightTip = "Too dark — face a window or a lamp";
  else if (mean > 205) lightTip = "Too bright — step out of direct light";
  else if (std < 18) lightTip = "Low contrast — avoid a bright light behind you";
  const lightOk = lightTip === "Good light";
  push("light", lightOk, "warn", lightTip);

  const sharpness = laplacianVariance(patch.gray, patch.w, patch.h);
  const sharpOk = sharpness >= 18;
  push("sharp", sharpOk, "warn", sharpOk ? "Sharp" : mode === "webcam" ? "Hold still — it's blurry" : "This photo is blurry");

  if (blink) {
    const open = Math.max(blink.left, blink.right) < 0.55;
    push("eyes", open, "warn", open ? "Eyes open" : "Keep your eyes open");
  }

  const usable = checks.every((c) => c.ok || c.severity === "warn");
  const perfect = checks.every((c) => c.ok);
  const passed = checks.filter((c) => c.ok).length / checks.length;
  const score = usable ? passed * 0.7 + Math.min(1, sharpness / 120) * 0.3 : 0;
  return { checks, usable, perfect, geometry: geo, score };
}
