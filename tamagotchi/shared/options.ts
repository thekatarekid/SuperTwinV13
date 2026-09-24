// The customization catalog. Shared by the UI (pickers) and the server (prompt
// builder), so the server only ever turns whitelisted ids into prompt text —
// the browser never sends free-form prompt text.

export type AttributeKey = "style" | "suit" | "palette" | "accessories" | "power";

export interface Choice {
  id: string;
  label: string;
  emoji: string;
  /** Prompt fragment the server splices in. Never shown to the user. */
  prompt: string;
}

export interface Attribute {
  key: AttributeKey;
  label: string;
  /** How many choices may be picked (accessories allow two). */
  max: number;
  choices: Choice[];
}

export const ATTRIBUTES: Attribute[] = [
  {
    key: "style",
    label: "Art style",
    max: 1,
    choices: [
      {
        id: "chibi3d",
        label: "3D toy",
        emoji: "🧸",
        prompt:
          "a glossy 3D-rendered chibi vinyl collectible toy, soft studio lighting, smooth rounded shapes, subtle subsurface skin shading, Pixar-like",
      },
      {
        id: "sticker",
        label: "Kawaii sticker",
        emoji: "🌸",
        prompt:
          "a kawaii 2D sticker illustration, flat bright colors, clean thick dark outline, simple cel shading",
      },
      {
        id: "anime",
        label: "Anime",
        emoji: "✨",
        prompt:
          "a chibi anime illustration, crisp line art, soft cel shading, sparkling expressive eyes",
      },
      {
        id: "clay",
        label: "Claymation",
        emoji: "🪄",
        prompt:
          "a handmade claymation figure, visible soft clay texture, matte finish, stop-motion look",
      },
      {
        id: "pixel",
        label: "Pixel art",
        emoji: "👾",
        prompt:
          "detailed 64-bit pixel art sprite, crisp square pixels, limited palette, no anti-aliasing blur",
      },
    ],
  },
  {
    key: "suit",
    label: "Suit",
    max: 1,
    choices: [
      {
        id: "classic",
        label: "Classic spandex",
        emoji: "🦸",
        prompt: "a classic comic-book superhero bodysuit with a belt and boots",
      },
      {
        id: "armor",
        label: "Mech armor",
        emoji: "🤖",
        prompt: "chunky rounded high-tech power armor with glowing panel lines (helmet off, face fully visible)",
      },
      {
        id: "ninja",
        label: "Ninja",
        emoji: "🥷",
        prompt: "a cute ninja hero outfit with a sash and wrapped sleeves (no face covering)",
      },
      {
        id: "space",
        label: "Space ranger",
        emoji: "🚀",
        prompt: "a puffy space-ranger suit with a chest control panel (no helmet, face fully visible)",
      },
      {
        id: "wizard",
        label: "Wizard robe",
        emoji: "🧙",
        prompt: "a heroic wizard robe with star trim and a short cloak",
      },
    ],
  },
  {
    key: "palette",
    label: "Colors",
    max: 1,
    choices: [
      { id: "crimson", label: "Crimson & gold", emoji: "🔴", prompt: "crimson red and gold" },
      { id: "ocean", label: "Ocean blue", emoji: "🔵", prompt: "deep ocean blue and silver" },
      { id: "jungle", label: "Jungle green", emoji: "🟢", prompt: "emerald green and lime" },
      { id: "violet", label: "Cosmic violet", emoji: "🟣", prompt: "violet purple and hot pink" },
      { id: "midnight", label: "Midnight", emoji: "⚫", prompt: "matte black and electric yellow" },
    ],
  },
  {
    key: "accessories",
    label: "Accessories",
    max: 2,
    choices: [
      { id: "cape", label: "Cape", emoji: "🧣", prompt: "a short flowing cape" },
      { id: "mask", label: "Eye mask", emoji: "🎭", prompt: "a small domino eye mask that leaves the eyes, eyebrows and face shape clearly visible" },
      { id: "goggles", label: "Goggles", emoji: "🥽", prompt: "aviator goggles pushed up on the forehead (not covering the eyes)" },
      { id: "crown", label: "Tiny crown", emoji: "👑", prompt: "a tiny tilted crown" },
      { id: "headphones", label: "Headphones", emoji: "🎧", prompt: "chunky headphones around the neck" },
    ],
  },
  {
    key: "power",
    label: "Power",
    max: 1,
    choices: [
      { id: "lightning", label: "Lightning", emoji: "⚡", prompt: "lightning — a lightning-bolt chest emblem and a few small sparks near one hand" },
      { id: "fire", label: "Fire", emoji: "🔥", prompt: "fire — a flame chest emblem and a small flame hovering over one palm" },
      { id: "ice", label: "Ice", emoji: "❄️", prompt: "ice — a snowflake chest emblem and a few tiny ice crystals near one hand" },
      { id: "nature", label: "Nature", emoji: "🌿", prompt: "nature — a leaf chest emblem and a small sprouting vine curling around one wrist" },
      { id: "cosmic", label: "Cosmic", emoji: "🌌", prompt: "cosmic — a star chest emblem and a few tiny orbiting stars near one hand" },
    ],
  },
];

export type Selection = Record<AttributeKey, string[]>;

export const DEFAULT_SELECTION: Selection = {
  style: ["chibi3d"],
  suit: ["classic"],
  palette: ["crimson"],
  accessories: ["cape"],
  power: ["lightning"],
};

export function getAttribute(key: AttributeKey): Attribute {
  const attr = ATTRIBUTES.find((a) => a.key === key);
  if (!attr) throw new Error(`unknown attribute ${key}`);
  return attr;
}

export function getChoice(key: AttributeKey, id: string): Choice | undefined {
  return getAttribute(key).choices.find((c) => c.id === id);
}

/**
 * Validates an untrusted selection (e.g. a request body). Returns a clean
 * selection or a human-readable error. Unknown keys are ignored; every known
 * attribute except accessories needs exactly one valid pick.
 */
export function parseSelection(input: unknown): { ok: true; value: Selection } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "options must be an object" };
  const raw = input as Record<string, unknown>;
  const out = {} as Selection;
  for (const attr of ATTRIBUTES) {
    const v = raw[attr.key];
    const ids = Array.isArray(v) ? v : v === undefined ? [] : [v];
    if (!ids.every((id): id is string => typeof id === "string")) {
      return { ok: false, error: `${attr.key}: expected string ids` };
    }
    const unique = [...new Set(ids)];
    if (unique.length > attr.max) return { ok: false, error: `${attr.key}: pick at most ${attr.max}` };
    if (attr.key !== "accessories" && unique.length !== 1) {
      return { ok: false, error: `${attr.key}: pick exactly one` };
    }
    for (const id of unique) {
      if (!getChoice(attr.key, id)) return { ok: false, error: `${attr.key}: unknown choice "${id}"` };
    }
    out[attr.key] = unique;
  }
  return { ok: true, value: out };
}

/** Pet names are shown in the UI and spliced into speech — keep them tame. */
export function cleanName(input: unknown): string {
  if (typeof input !== "string") return "";
  return input
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} '\-]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20);
}
