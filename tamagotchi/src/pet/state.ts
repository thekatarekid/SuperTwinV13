// Tamagotchi rules. Pure functions over a plain object so the whole loop is
// unit-testable with a fake clock. Stats are 0..100, higher is better.

export interface PetStats {
  food: number;
  joy: number;
  energy: number;
  asleep: boolean;
  /** Last time stats were brought up to date (ms since epoch). */
  updatedAt: number;
}

export type Mood = "sleeping" | "hungry" | "tired" | "sad" | "happy" | "okay";

const HOUR = 3_600_000;
// Points per hour. Tuned so a pet left alone for a work day gets hungry but
// never "dies" — this is a friendly pet, stats just bottom out at 0.
const DECAY_AWAKE = { food: 7, joy: 6, energy: 5 };
const DECAY_ASLEEP = { food: 3, joy: 1, energy: -25 }; // sleeping restores energy

const clamp = (v: number) => Math.max(0, Math.min(100, v));

export function newStats(now: number): PetStats {
  return { food: 80, joy: 80, energy: 80, asleep: false, updatedAt: now };
}

/** Advances the stats to `now` (handles days away in one step). */
export function tick(s: PetStats, now: number): PetStats {
  const hours = Math.max(0, now - s.updatedAt) / HOUR;
  if (hours === 0) return s;
  const rate = s.asleep ? DECAY_ASLEEP : DECAY_AWAKE;
  const next: PetStats = {
    ...s,
    food: clamp(s.food - rate.food * hours),
    joy: clamp(s.joy - rate.joy * hours),
    energy: clamp(s.energy - rate.energy * hours),
    updatedAt: now,
  };
  // A sleeping pet wakes up by itself once rested.
  if (next.asleep && next.energy >= 100) next.asleep = false;
  return next;
}

export type Action = "feed" | "play" | "sleep" | "wake";

export interface ActionResult {
  stats: PetStats;
  /** False when the pet refuses (e.g. playing while exhausted). */
  accepted: boolean;
  reason?: string;
}

export function act(prev: PetStats, action: Action, now: number): ActionResult {
  const s = tick(prev, now);
  switch (action) {
    case "feed":
      if (s.asleep) return { stats: s, accepted: false, reason: "Shh… sleeping." };
      if (s.food >= 95) return { stats: s, accepted: false, reason: "I'm stuffed!" };
      return { stats: { ...s, food: clamp(s.food + 25), joy: clamp(s.joy + 3) }, accepted: true };
    case "play":
      if (s.asleep) return { stats: s, accepted: false, reason: "Shh… sleeping." };
      if (s.energy < 15) return { stats: s, accepted: false, reason: "Too tired to play…" };
      if (s.food < 10) return { stats: s, accepted: false, reason: "Too hungry to play…" };
      return { stats: { ...s, joy: clamp(s.joy + 20), energy: clamp(s.energy - 10), food: clamp(s.food - 5) }, accepted: true };
    case "sleep":
      if (s.asleep) return { stats: s, accepted: false };
      if (s.energy > 90) return { stats: s, accepted: false, reason: "Not sleepy yet!" };
      return { stats: { ...s, asleep: true }, accepted: true };
    case "wake":
      if (!s.asleep) return { stats: s, accepted: false };
      return { stats: { ...s, asleep: false, joy: clamp(s.joy - (s.energy < 60 ? 5 : 0)) }, accepted: true };
  }
}

export function moodOf(s: PetStats): Mood {
  if (s.asleep) return "sleeping";
  if (s.food < 30) return "hungry";
  if (s.energy < 25) return "tired";
  if (s.joy < 30) return "sad";
  if (s.food > 60 && s.joy > 60 && s.energy > 50) return "happy";
  return "okay";
}

const LINES: Record<Mood, string[]> = {
  sleeping: ["Zzz…"],
  hungry: ["My tummy is rumbling!", "Hero fuel, please?", "Is it snack time?"],
  tired: ["I need a power nap…", "So… sleepy…", "Even heroes need rest."],
  sad: ["Play with me?", "I'm bored…", "Did you forget about me?"],
  happy: ["Ready to save the day!", "Best day ever!", "You're my hero too!"],
  okay: ["Hi there!", "What's our next mission?", "Heroing is fun!"],
};

export function lineFor(mood: Mood, name: string, pick = Math.random()): string {
  const options = LINES[mood];
  const line = options[Math.floor(pick * options.length) % options.length];
  return mood === "happy" && name && pick < 0.3 ? `${name} is ready to save the day!` : line;
}
