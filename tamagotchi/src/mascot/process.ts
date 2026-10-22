import { getLandmarker } from "../face/landmarker.ts";
import { removeBackground } from "./cutout.ts";
import { estimateArms, estimateRig, rigFromLandmarks, rigLooksValid, type Rig } from "./rig.ts";

export interface Sprite {
  /** Transparent PNG, square, feet near the bottom. */
  png: string;
  rig: Rig;
  /** Whether the background was removed cleanly. */
  cutout: boolean;
}

export const SPRITE_SIZE = 768;

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't read the generated image"));
    img.src = src;
  });
}

/**
 * Generated image → animatable sprite: cut out the background, re-frame the
 * character consistently (same size and floor line for every pet), then find
 * the eyes, mouth and head so the puppet can blink, talk and look around.
 */
export async function makeSprite(imageDataUrl: string): Promise<Sprite> {
  const img = await loadImage(imageDataUrl);
  const W = 1024;
  const src = document.createElement("canvas");
  src.width = src.height = W;
  const sctx = src.getContext("2d", { willReadFrequently: true })!;
  sctx.fillStyle = "#fff";
  sctx.fillRect(0, 0, W, W);
  sctx.drawImage(img, 0, 0, W, W);
  const raw = sctx.getImageData(0, 0, W, W);

  const cut = removeBackground({ data: raw.data, width: W, height: W });
  const cutout = cut.ok;
  const bbox = cutout && cut.bbox ? cut.bbox : { x: 0, y: 0, w: W, h: W };
  if (cutout) sctx.putImageData(new ImageData(new Uint8ClampedArray(cut.image.data), W, W), 0, 0);

  // Re-frame: character height → 82% of the sprite, feet 3% above the bottom
  // (headroom for hops and raised arms).
  const S = SPRITE_SIZE;
  const scale = Math.min((S * 0.82) / bbox.h, (S * 0.9) / bbox.w);
  const dw = bbox.w * scale;
  const dh = bbox.h * scale;
  const dx = (S - dw) / 2;
  const dy = S * 0.97 - dh;
  const out = document.createElement("canvas");
  out.width = out.height = S;
  const octx = out.getContext("2d")!;
  octx.imageSmoothingQuality = "high";
  octx.drawImage(src, bbox.x, bbox.y, bbox.w, bbox.h, dx, dy, dw, dh);

  const nb = { x: dx / S, y: dy / S, w: dw / S, h: dh / S };
  const rig = (await detectRig(out, nb)) ?? estimateRig(nb);
  if (cutout) {
    const px = octx.getImageData(0, 0, S, S).data;
    const alpha = new Uint8Array(S * S);
    for (let i = 0; i < alpha.length; i++) alpha[i] = px[i * 4 + 3];
    rig.arms = estimateArms(alpha, S, rig);
  }
  return { png: out.toDataURL("image/png"), rig, cutout };
}

async function detectRig(sprite: HTMLCanvasElement, nb: { x: number; y: number; w: number; h: number }): Promise<Rig | null> {
  try {
    // Landmarker wants an opaque image: composite on white.
    const flat = document.createElement("canvas");
    flat.width = flat.height = sprite.width;
    const ctx = flat.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, flat.width, flat.height);
    ctx.drawImage(sprite, 0, 0);
    const lm = await getLandmarker("IMAGE");
    const res = lm.detect(flat);
    const face = res.faceLandmarks[0];
    if (!face) return null;
    const rig = rigFromLandmarks(face, nb.y + nb.h);
    return rigLooksValid(rig, nb) ? rig : null;
  } catch {
    return null;
  }
}
