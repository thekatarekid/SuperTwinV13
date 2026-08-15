// ===========================================================================
// Question -> FTS5 MATCH expression (docs/v6-spec.md §1).
//
// Measured on the live DB: of 90 candidate rows for "Do i have anything planned
// on sunday", 88 matched ONLY on do/have/anything/on, and bm25 spent five of
// eight slots on them. `"sunday" OR "planned"` alone returns two rows and both
// are right — precision was never the problem, so this module throws the
// function words away and spends the recall budget somewhere it buys something:
//
//   - a crude suffix stem, as a prefix term, so "booked" reaches "booking";
//   - every plausible spelling of the dates the question refers to, which is
//     the only bridge from "sunday" to "booking on 02 Aug 2026".
//
// Query construction lives here rather than in db/retrieval.ts on purpose: that
// layer takes a MATCH expression and returns rows, and knows nothing about
// stopwords, calendars or what a user typed.
// ===========================================================================

import { dateMatchPhrases, resolveDates, type DateResolution } from "./dates.js";

/**
 * Function words, English and romanized Hindi/Marathi — these chats are all
 * four languages at once, and an English-only list leaves "hai"/"kya"/"nahi"
 * pulling in every message ever sent.
 *
 * Only words that carry no topic. Verbs that could BE the question ("book",
 * "plan", "pay") are deliberately absent: dropping one of those drops the
 * question.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  // English determiners, pronouns, prepositions, auxiliaries
  "a", "an", "the", "am", "is", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "doing", "done", "have", "has", "had", "having",
  "i", "me", "my", "mine", "we", "us", "our", "ours", "you", "your", "yours",
  "he", "him", "his", "she", "her", "hers", "it", "its", "they", "them",
  "their", "theirs", "this", "that", "these", "those",
  "and", "or", "but", "if", "then", "so", "of", "in", "on", "at", "to", "from",
  "for", "with", "by", "about", "as", "into", "onto", "over", "under", "up",
  "down", "out", "off", "again", "still", "yet",
  "any", "anything", "anyone", "anybody", "some", "something", "someone",
  "everything", "everyone", "all", "both", "each", "few", "more", "most",
  "other", "another", "such", "no", "nor", "not", "only", "own", "same",
  "than", "too", "very", "can", "could", "will", "would", "shall", "should",
  "may", "might", "must", "just", "now", "there", "here",
  "what", "whats", "when", "where", "who", "whom", "which", "why", "how",
  "whose", "whether",
  // Romanized Hindi / Marathi function words
  "hai", "hain", "haan", "ha", "hoy", "hota", "hoti", "hote", "tha", "thi",
  "the", "hu", "hun", "hoon", "ho", "hoga", "hogi", "honge",
  "kya", "kaun", "kab", "kahan", "kaha", "kaise", "kyun", "kyu", "kitna",
  "ka", "ki", "ke", "ko", "se", "ne", "mein", "par", "pe", "tak",
  "aur", "ya", "nahi", "nahin", "na", "toh", "bhi", "hi", "ek",
  "mera", "meri", "mere", "tera", "teri", "tere", "uska", "uski", "unka",
  "hamara", "tumhara", "apna", "apne", "mala", "tula", "maza", "tuza",
  "aahe", "ahe", "aahet", "nahiye", "kay", "kuthe", "kasa", "kadhi",
]);

/** Cheap English suffix strip, used only to build a PREFIX term. */
const SUFFIXES: readonly [string, number][] = [
  ["ing", 6],
  ["ed", 5],
  ["es", 5],
  ["s", 5],
];

/**
 * Below this the FTS index is doing more harm than good: a two-character prefix
 * matches half the corpus and bm25 has to sort the mess out.
 */
const MIN_PREFIX_CHARS = 4;

export interface QueryPlan {
  /** Content words kept from the question, lowercased and sanitized. */
  terms: string[];
  /** Function words thrown away — reported so a diagnostic can show them. */
  dropped: string[];
  /** Prefix terms derived from `terms` ("booked" -> book, matching "booking"). */
  prefixes: string[];
  /** Multi-token phrases: the spellings of every date the question refers to. */
  phrases: string[];
  /**
   * Tokens that could be somebody's name, for `resolveChannelsByName` (v7 §6,
   * lever 1). The stems are in it as well as the terms because a question asks
   * about a person possessively far more often than not, and sanitize() turns
   * "pranjali's" into `pranjalis`, which is nobody's name.
   */
  names: string[];
  dates: DateResolution;
  /** The FTS5 MATCH expression, or "" when there is nothing to search for. */
  match: string;
}

/**
 * Strip a token to what FTS5's tokenizer would keep. Quotes go first: they are
 * the only characters that could end a phrase early and turn the rest of a
 * user's question into operators.
 */
function sanitize(token: string): string {
  return token
    .replace(/["']/g, "")
    .replace(/[^\p{L}\p{N}_-]+/gu, "")
    .toLowerCase()
    .trim();
}

/** The stem of an English-looking token, or null when there is nothing to gain. */
export function stemPrefix(token: string): string | null {
  if (!/^[a-z][a-z-]*$/.test(token)) return null;
  for (const [suffix, minLength] of SUFFIXES) {
    if (token.length >= minLength && token.endsWith(suffix)) {
      const stem = token.slice(0, token.length - suffix.length);
      return stem.length >= MIN_PREFIX_CHARS ? stem : null;
    }
  }
  return null;
}

/**
 * Plan the retrieval for one question, as of `now` in the user's local time.
 *
 * Stopwords are dropped unless they are ALL there is — "how are you" has no
 * content words, and searching for nothing returns nothing, which is a worse
 * answer than searching for what was typed.
 */
export function planQuery(query: string, now: Date): QueryPlan {
  // A token FTS5 would tokenize to nothing ("--", "!!") is not a short search,
  // it is an empty phrase, and an empty phrase is a syntax error.
  const tokens = query
    .split(/\s+/)
    .map(sanitize)
    .filter((t) => t.length > 1 && /[\p{L}\p{N}]/u.test(t));

  const terms: string[] = [];
  const dropped: string[] = [];
  for (const token of tokens) {
    if (STOPWORDS.has(token)) dropped.push(token);
    else if (!terms.includes(token)) terms.push(token);
  }
  if (terms.length === 0) {
    for (const token of dropped) if (!terms.includes(token)) terms.push(token);
  }

  const dates = resolveDates(query, now);

  const prefixes: string[] = [];
  for (const term of terms) {
    const stem = stemPrefix(term);
    if (stem && !prefixes.includes(stem)) prefixes.push(stem);
  }

  // The weekday name is how a chat writes a date far more often than the date
  // is: "sunday lunch chalna hai kahin?" carries no digits at all.
  const phrases: string[] = [];
  for (const date of dates.dates) {
    if (!terms.includes(date.weekday) && !phrases.includes(date.weekday)) {
      phrases.push(date.weekday);
    }
    for (const phrase of dateMatchPhrases(date.iso)) {
      if (!phrases.includes(phrase)) phrases.push(phrase);
    }
  }

  const branches = [
    ...terms.map((t) => `"${t}"`),
    ...prefixes.map((p) => `"${p}"*`),
    ...phrases.map((p) => `"${p}"`),
  ];

  const names: string[] = [];
  for (const token of [...terms, ...prefixes]) {
    if (!names.includes(token)) names.push(token);
  }

  return {
    terms,
    dropped,
    prefixes,
    phrases,
    names,
    dates,
    match: branches.join(" OR "),
  };
}
