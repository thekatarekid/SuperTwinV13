import { getChoice, type Selection } from "../shared/options.ts";

/**
 * Builds the face → mascot prompt. Order matters: image models weight the
 * start of the prompt most, so likeness comes first, then the rig-friendly
 * pose (the browser animates the result, so eyes/mouth/head must be where the
 * puppet expects them), then styling, then the cut-out-friendly background.
 */
export function buildMascotPrompt(sel: Selection, opts: { compact?: boolean } = {}): string {
  const pick = (key: keyof Selection) => sel[key].map((id) => getChoice(key, id)!.prompt);
  const [style] = pick("style");
  const [suit] = pick("suit");
  const [palette] = pick("palette");
  const [power] = pick("power");
  const accessories = pick("accessories");

  if (opts.compact) {
    // Small local models (FLUX.2 Klein, 512-token text window) do best with a
    // short edit instruction in the same priority order.
    return [
      "Turn this person into a cute chibi superhero mascot, keeping their exact face, skin tone, eye shape, eyebrows, hairstyle, hair color, facial hair and glasses so they are instantly recognizable.",
      "Full body, front view, facing the viewer, eyes open, gentle closed-mouth smile, arms slightly away from the body, big head and small body.",
      `Style: ${style}.`,
      `Outfit: ${suit} in ${palette}${accessories.length ? `, with ${accessories.join(" and ")}` : ""}.`,
      `Power: ${power}.`,
      "Centered, one character, plain solid white background, no shadow, no text.",
    ].join(" ");
  }

  return [
    "Turn the person in the reference photo into a cute chibi superhero mascot for a virtual pet game.",

    "LIKENESS IS THE TOP PRIORITY: the mascot must be instantly recognizable as this exact person. " +
      "Keep their face shape, skin tone, eye shape and eye color, eyebrow shape and thickness, nose, lips, " +
      "hairstyle, hairline, hair length, hair texture and hair color, facial hair, glasses (same frame shape), " +
      "freckles, moles, dimples and any other distinctive features exactly as in the photo. " +
      "Simplify and stylize, but do not beautify, change age, change ethnicity, change gender presentation, or swap the hairstyle.",

    "POSE: full body, standing, straight-on front view facing the viewer, head upright and level, " +
      "both eyes open looking at the viewer, mouth closed in a gentle smile, arms relaxed slightly away from the body, " +
      "both feet visible. Chibi proportions: head about 40% of total height, small rounded body, short limbs.",

    `STYLE: ${style}.`,
    `OUTFIT: ${suit}, colored ${palette}.` +
      (accessories.length ? ` Accessories: ${accessories.join("; ")}.` : ""),
    `POWER: ${power}. Keep effects small and away from the face.`,

    "FRAMING: one character only, centered, filling about 80% of the image height, with empty margin on every side. " +
      "BACKGROUND: perfectly flat solid pure white (#FFFFFF). No floor, no cast shadow, no scenery, no text, no logo, no watermark, no border, no frame.",
  ].join("\n\n");
}
