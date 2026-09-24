import { blendshape, getLandmarker } from "../face/landmarker.ts";
import { faceGeometry } from "../face/geometry.ts";
import type { PuppetParams } from "./puppet.ts";

// "Mirror me" — live mode. Your webcam face drives the mascot in real time:
// head turn / nod / tilt, both blinks and your jaw. Runs entirely on-device,
// so it is free no matter how long you play (the Muse-style "live" feel
// without a GPU server rendering video for you).

export interface MirrorSample {
  yaw: number;
  pitch: number;
  roll: number;
  blink: [number, number];
  mouth: number;
  found: boolean;
}

export class Mirror {
  private stream: MediaStream | null = null;
  private video = document.createElement("video");
  private smooth: MirrorSample = { yaw: 0, pitch: 0, roll: 0, blink: [0, 0], mouth: 0, found: false };
  private lastTs = -1;
  private baselinePitch: number | null = null;

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
    await getLandmarker("VIDEO");
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  get element(): HTMLVideoElement {
    return this.video;
  }

  /** Call once per animation frame; returns smoothed puppet controls. */
  async sample(now: number): Promise<MirrorSample> {
    if (!this.stream || this.video.readyState < 2) return this.smooth;
    const lm = await getLandmarker("VIDEO");
    const ts = Math.max(now, this.lastTs + 1);
    this.lastTs = ts;
    const res = lm.detectForVideo(this.video, ts);
    const face = res.faceLandmarks[0];
    if (!face) {
      this.smooth = { ...this.smooth, found: false };
      return this.smooth;
    }
    const g = faceGeometry(face, this.video.videoWidth, this.video.videoHeight);
    if (this.baselinePitch === null) this.baselinePitch = g.pitch;
    this.baselinePitch += (g.pitch - this.baselinePitch) * 0.002; // slow re-centre
    // Mirrored: when you turn left, the mascot on screen turns the same way a reflection would.
    const target: MirrorSample = {
      yaw: clamp(-g.yaw * 3.2),
      pitch: clamp((g.pitch - this.baselinePitch) * 6),
      roll: clamp((-g.rollDeg * Math.PI) / 180, 0.5),
      blink: [ease(blendshape(res, "eyeBlinkLeft")), ease(blendshape(res, "eyeBlinkRight"))],
      mouth: clamp(blendshape(res, "jawOpen") * 1.8, 1, 0),
      found: true,
    };
    const k = 0.45;
    const s = this.smooth;
    this.smooth = {
      yaw: s.yaw + (target.yaw - s.yaw) * k,
      pitch: s.pitch + (target.pitch - s.pitch) * k,
      roll: s.roll + (target.roll - s.roll) * k,
      blink: target.blink, // blinks must be snappy
      mouth: s.mouth + (target.mouth - s.mouth) * 0.6,
      found: true,
    };
    return this.smooth;
  }
}

export function applyMirror(base: PuppetParams, m: MirrorSample): PuppetParams {
  if (!m.found) return base;
  return { ...base, yaw: m.yaw, pitch: m.pitch, roll: m.roll, blink: m.blink, mouth: Math.max(m.mouth, 0) };
}

function clamp(v: number, max = 1, min = -max) {
  return Math.max(min, Math.min(max, v));
}

/** Blink blendshapes hover around 0.3 with eyes open; remap so open = 0. */
function ease(v: number) {
  return clamp((v - 0.35) / 0.4, 1, 0);
}
