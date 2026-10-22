import type { FaceGeometry } from "./geometry.ts";

export interface CropPlan {
  /** Crop centre in source pixels. */
  cx: number;
  cy: number;
  /** Side of the square crop in source pixels. */
  side: number;
  /** Rotation applied so the eye line comes out level (radians). */
  angle: number;
}

/**
 * Head-and-shoulders square crop, eye line levelled. The face (forehead→chin)
 * ends up ~48% of the crop height with room above for hair — the framing
 * image models keep likeness best from: big enough to read features, loose
 * enough to see the hairstyle.
 */
export function planCrop(geo: FaceGeometry): CropPlan {
  const H = geo.faceHeight;
  const roll = (geo.rollDeg * Math.PI) / 180;
  const midX = (geo.forehead.x + geo.chin.x) / 2;
  const midY = (geo.forehead.y + geo.chin.y) / 2;
  // "Up" in the face's own frame (perpendicular to the eye line).
  const upX = Math.sin(roll);
  const upY = -Math.cos(roll);
  const lift = 0.12 * H;
  return { cx: midX + upX * lift, cy: midY + upY * lift, side: 2.1 * H, angle: -roll };
}

/** Renders the crop to a square canvas; out-of-frame areas get a blurred fill. */
export function renderCrop(source: CanvasImageSource, srcW: number, srcH: number, plan: CropPlan, out = 1024): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = out;
  const ctx = canvas.getContext("2d")!;
  const scale = out / plan.side;

  // Blurred cover fill so padding (face near an edge) looks natural, not black.
  ctx.save();
  ctx.filter = "blur(24px)";
  const cover = Math.max(out / srcW, out / srcH);
  ctx.drawImage(source, (out - srcW * cover) / 2, (out - srcH * cover) / 2, srcW * cover, srcH * cover);
  ctx.restore();

  ctx.save();
  ctx.translate(out / 2, out / 2);
  ctx.rotate(plan.angle);
  ctx.scale(scale, scale);
  ctx.translate(-plan.cx, -plan.cy);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, srcW, srcH);
  ctx.restore();
  return canvas;
}
