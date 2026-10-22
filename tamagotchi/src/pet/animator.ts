import type { Mood } from "./state.ts";
import { NEUTRAL, type PuppetParams } from "./puppet.ts";

// Procedural "alive" layer: breathing, blinking, glancing around, and short
// reaction clips (eat / play / tap / refuse). Moods change the baseline, so a
// tired pet squints and slumps and a happy one bounces.

export type Reaction = "eat" | "play" | "tap" | "refuse" | "wake" | "wave";

const REACTION_MS: Record<Reaction, number> = { eat: 1800, play: 2000, tap: 650, refuse: 900, wake: 1200, wave: 1600 };

export class Animator {
  mood: Mood = "okay";
  /** 0..1 mouth level while speaking (set by the speech module). */
  talk = 0;

  private nextBlinkAt = 0;
  private blinkStart = -1;
  private gaze = { yaw: 0, pitch: 0 };
  private gazeTarget = { yaw: 0, pitch: 0 };
  private nextGlanceAt = 0;
  private reaction: { kind: Reaction; start: number } | null = null;
  private last = 0;

  constructor(private rand: () => number = Math.random) {}

  react(kind: Reaction, now: number) {
    this.reaction = { kind, start: now };
  }

  frame(now: number): PuppetParams {
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0.016;
    this.last = now;
    const t = now / 1000;
    const p: PuppetParams = { ...NEUTRAL, blink: [0, 0], arms: [0, 0] };
    const mood = this.mood;
    const sleeping = mood === "sleeping";

    // Breathing: slower and deeper when asleep.
    const period = sleeping ? 4.6 : mood === "happy" ? 2.6 : 3.4;
    p.breath = Math.sin((t * 2 * Math.PI) / period) * (sleeping ? 1.6 : 1);

    // Glances.
    if (now >= this.nextGlanceAt) {
      const range = mood === "happy" ? 0.7 : 0.5;
      this.gazeTarget = { yaw: (this.rand() * 2 - 1) * range, pitch: (this.rand() * 2 - 1) * 0.25 };
      if (this.rand() < 0.35) this.gazeTarget = { yaw: 0, pitch: 0 }; // look at the player
      this.nextGlanceAt = now + 1400 + this.rand() * 2800;
    }
    const k = 1 - Math.exp(-dt * 7);
    this.gaze.yaw += (this.gazeTarget.yaw - this.gaze.yaw) * k;
    this.gaze.pitch += (this.gazeTarget.pitch - this.gaze.pitch) * k;
    p.yaw = sleeping ? 0 : this.gaze.yaw;
    p.pitch = sleeping ? 0.35 : this.gaze.pitch;

    // Mood posture.
    if (mood === "sad") {
      p.pitch += 0.45;
      p.roll = 0.06;
    } else if (mood === "tired") {
      p.pitch += 0.25;
      p.roll = Math.sin(t * 0.8) * 0.06;
    } else if (sleeping) {
      p.roll = 0.14 + Math.sin(t * 0.5) * 0.03;
    } else if (mood === "happy") {
      p.roll = Math.sin(t * 1.3) * 0.05;
      const hopPhase = (t % 3.2) / 3.2; // a little bounce every few seconds
      if (hopPhase < 0.14) {
        const u = hopPhase / 0.14;
        p.hop = Math.sin(u * Math.PI) * 0.035;
        p.stretch = 1 + Math.sin(u * Math.PI) * 0.05;
      }
    } else if (mood === "hungry") {
      p.sway = Math.sin(t * 2.2) * 0.006;
    }

    // Blinks (random, occasionally double).
    if (sleeping) {
      p.blink = [1, 1];
    } else {
      if (this.nextBlinkAt === 0) this.nextBlinkAt = now + 800 + this.rand() * 3000;
      if (now >= this.nextBlinkAt && this.blinkStart < 0) {
        this.blinkStart = now;
        this.nextBlinkAt = now + (this.rand() < 0.2 ? 260 : 1800 + this.rand() * 4200);
      }
      let b = 0;
      if (this.blinkStart >= 0) {
        const u = (now - this.blinkStart) / 170;
        if (u >= 1) this.blinkStart = -1;
        else b = Math.sin(u * Math.PI);
      }
      const base = mood === "tired" ? 0.45 : mood === "sad" ? 0.2 : 0;
      const v = Math.max(base, b);
      p.blink = [v, v];
    }

    // Reactions override the baseline for a moment.
    const r = this.reaction;
    if (r) {
      const e = now - r.start;
      const dur = REACTION_MS[r.kind];
      if (e > dur) this.reaction = null;
      else {
        const u = e / dur;
        switch (r.kind) {
          case "eat":
            p.mouth = 0.25 + 0.55 * Math.abs(Math.sin(e / 95));
            p.pitch = 0.2;
            p.yaw *= 0.3;
            break;
          case "wave": {
            // Right hand up, waving from the elbow-ish.
            const up = Math.min(1, u * 5, (1 - u) * 5);
            p.arms = [0, up * (0.78 + Math.sin(e / 110) * 0.14)];
            p.roll = -0.05 * up;
            p.mouth = 0.2 * up;
            break;
          }
          case "play": {
            const hopU = (u * 3) % 1; // three hops
            const up = Math.min(1, u * 6, (1 - u) * 6);
            p.arms = [up * (0.85 + Math.sin(e / 90) * 0.1), up * (0.85 - Math.sin(e / 90) * 0.1)]; // celebrate
            p.hop = Math.sin(hopU * Math.PI) * 0.07;
            p.stretch = hopU < 0.12 || hopU > 0.88 ? 0.9 : 1.06;
            p.roll = Math.sin(u * Math.PI * 6) * 0.1;
            p.mouth = 0.35;
            p.blink = [0, 0];
            break;
          }
          case "tap":
            p.stretch = 1 + Math.cos(u * Math.PI * 4) * 0.12 * (1 - u);
            p.blink = [0.9 * (1 - u), 0.9 * (1 - u)];
            break;
          case "refuse":
            p.yaw = Math.sin(u * Math.PI * 5) * 0.8 * (1 - u);
            break;
          case "wake": {
            const s = Math.sin(u * Math.PI);
            p.arms = [s * 0.9, s * 0.9]; // big stretch
            p.stretch = 1 + s * 0.1;
            p.blink = [1 - u, 1 - u];
            p.mouth = s * 0.7; // yawn
            break;
          }
        }
      }
    }

    if (this.talk > 0) p.mouth = Math.max(p.mouth, this.talk);
    return p;
  }
}
