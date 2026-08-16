// ===========================================================================
// [CODE] Rich text for comparison — arch §10.3 ¶4, build item 0.7.
//
// "Never compare bare short strings." Two contact names are three tokens of
// nothing in a 384-dimensional space: every short string sits near the centre
// of the embedding and therefore scores high against every other short string,
// which is how "Ma" and "Max" become one person. What gets embedded is the
// name PLUS its aliases, the entities it co-occurs with, and a quote.
//
// The guard is a THROW, not a filter. A caller that hands over a bare string
// has a bug in what it composed, and silently embedding it anyway is how the
// rule stops being a rule.
// ===========================================================================

/**
 * Arch §10.3 ¶4: "Never compare bare short strings." Two contact names are
 * three tokens of nothing in a 384-dimensional space — every short string sits
 * near the centre and scores high against every other short string, which is
 * how "Ma" and "Max" become the same person. What gets embedded is the name
 * PLUS aliases, co-occurring entities and a quote.
 */
export const RICH_TEXT_MIN_CHARS = 24;
export const RICH_TEXT_MIN_TOKENS = 3;

export function isRichText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < RICH_TEXT_MIN_CHARS) return false;
  return trimmed.split(/\s+/).filter((t) => t.length > 0).length >= RICH_TEXT_MIN_TOKENS;
}

/** Thrown when something tries to compare a bare string. */
export class BareStringComparisonError extends Error {
  constructor(text: string, where: string) {
    super(
      `${where}: refusing to embed a bare short string (${JSON.stringify(text.slice(0, 40))}) — ` +
        `compose rich text (name + aliases + co-occurring entities + a quote) first`,
    );
    this.name = "BareStringComparisonError";
  }
}

export function assertRichText(text: string, where: string): void {
  if (!isRichText(text)) throw new BareStringComparisonError(text, where);
}

export interface RichTextParts {
  name?: string | null;
  aliases?: readonly string[];
  cooccurring?: readonly string[];
  quote?: string | null;
  context?: string | null;
}

/** Compose the text that actually gets embedded, in a stable field order. */
export function buildRichText(parts: RichTextParts): string {
  const segments: string[] = [];
  const push = (label: string, value: string | null | undefined): void => {
    const v = (value ?? "").trim();
    if (v.length > 0) segments.push(`${label}: ${v}`);
  };
  push("name", parts.name);
  if (parts.aliases?.length) push("aliases", parts.aliases.join(", "));
  if (parts.cooccurring?.length) push("with", parts.cooccurring.join(", "));
  push("context", parts.context);
  push("quote", parts.quote);
  return segments.join(" · ");
}
