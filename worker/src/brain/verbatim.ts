// ===========================================================================
// [CODE] The verbatim-evidence matcher — one implementation, two callers
// (FIX-C2; Product_V6_Phase1 §17 rule 3, §21 rule 4: "no write without
// evidence — event ids plus a verbatim quote, or the commit path rejects").
//
// WHY THIS FILE EXISTS. The rule is right and stays; the MATCHER behind it was
// costing a fortune. On the 13.11.5 install `bundle_attempts.last_error` was
// dominated by `evidence_not_verbatim`, and every one of those threw away a
// whole ~22K-token Orient pass over ONE span. Worse, the two checks disagreed:
// brain/commit.ts folded NFC and whitespace and compared case-sensitively;
// brain/critic.ts lower-cased and did not fold NFC. So the critic could pass an
// item the commit then rejected, and vice versa — the model was being graded
// against a bar the writer did not use.
//
// WHAT THE MODEL ACTUALLY DID WRONG (read off the user's own rows):
//
//   "Kaam start naui hua ab tak… meeting stakeholders and und…"
//        the text says "…ab tak... Abhi tak to meeting stakeholders…" — the
//        model ELIDED the middle and marked it with an ellipsis.
//   "Nice; Are waah"  is not in e27,e28
//        "Nice" is e27 and "Are waah" is e28 — the model JOINED two events.
//   "Reading that as next weekend since this Sunday's 1pm is…"
//        a typographic apostrophe against the source's ASCII one.
//   "Happy teacher's day Uncle and Aunty and didi !!<emoji>"
//        emoji variation selectors / skin-tone modifiers that do not survive
//        the round trip through the pack.
//
// None of those is a fabrication. A fabrication is "booked the villa" over a
// source that says "thinking about booking the villa" — and that still fails,
// because every SPAN must be present, in order, in the cited events.
//
// SO: fold the typography on BOTH sides (never on one — folding one side would
// make a difference disappear), split the quote at the model's own elision and
// join marks, and require every span in order across the cited texts. Case is
// NOT folded: "villa sol" over "Villa Sol" stays a reject, as CMT-04 says.
// ===========================================================================

/**
 * Characters that mean the same thing and print the same way but do not
 * compare equal. Applied identically to the quote and to the source text, so
 * this can only ever cancel a difference that was never a difference.
 */
const FOLD: ReadonlyArray<readonly [RegExp, string]> = [
  // Typographic single quotes / primes -> ASCII apostrophe.
  [/[‘’‚‛′]/g, "'"],
  // Typographic double quotes / guillemets / double prime -> ASCII quote.
  [/[“”„‟″«»]/g, '"'],
  // Dash family -> hyphen-minus.
  [/[‐‑‒–—―−]/g, "-"],
  // Ellipsis -> three dots, so the elision split below sees one shape.
  [/…/g, "..."],
  // Zero-width joiners/spaces, BOM, variation selectors: no glyph, no meaning
  // for a quote, and a reliable source of phantom mismatches on emoji.
  [/[\u200B-\u200D\uFEFF\uFE00-\uFE0F]/g, ""],
  // Every exotic space (NBSP, narrow NBSP, en/em/thin/hair) -> plain space;
  // the whitespace collapse below then folds runs of them.
  [/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " "],
];

function fold(s: string): string {
  let out = s.normalize("NFC");
  for (const [re, to] of FOLD) out = out.replace(re, to);
  return out;
}

/** Source-side normalization: folded, NFC, whitespace collapsed. */
export function normalizeText(s: string): string {
  return fold(s).replace(/\s+/g, " ");
}

/** Quote-side: the same, plus trim and the model's outer quotation marks off. */
export function normalizeQuote(s: string): string {
  return fold(s)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'«»]+|["'«»]+$/g, "")
    .trim();
}

/**
 * Marks a model uses to STITCH or ELIDE, and nothing else. Deliberately narrow:
 *   `...`  an elision (already folded from `…`)
 *   `; `   two events joined into one quote
 *   ` · `  the pack's own field separator, echoed back
 * `/` is NOT here on purpose — "₹5,400 per night" must keep failing against
 * "₹5,400/night", and it does, because that is a rewording and not a join.
 */
const SEGMENT_SPLIT = /\.{3,}|;\s|\s·\s/;

/**
 * The quote's verbatim spans, in order. A quote with no elision and no join is
 * one span — itself — so the common case is unchanged.
 */
export function quoteSegments(quote: string): string[] {
  return normalizeQuote(quote)
    .split(SEGMENT_SPLIT)
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0);
}

/**
 * Is `quote` verbatim in `texts`?
 *
 * Every span of the quote must appear, IN ORDER, in the cited events read as
 * one run of text. Reading them as one run is what lets a quote that spans two
 * cited messages verify — the model cited both events, so both are evidence —
 * while a span that appears nowhere still fails, which is the whole rule.
 *
 * Empty quote, all-punctuation quote, or no cited text: not verbatim.
 */
export function quoteIsVerbatim(quote: string, texts: readonly string[]): boolean {
  const segments = quoteSegments(quote);
  if (segments.length === 0) return false;
  const usable = texts.filter((t) => typeof t === "string" && t.length > 0);
  if (usable.length === 0) return false;
  // Joined with a space: the same separator the whitespace collapse leaves
  // between two lines of one message, so a cross-event span reads naturally.
  const haystack = normalizeText(usable.join(" "));
  let cursor = 0;
  for (const seg of segments) {
    const at = haystack.indexOf(seg, cursor);
    if (at < 0) return false;
    cursor = at + seg.length;
  }
  return true;
}
