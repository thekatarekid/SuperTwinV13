// ===========================================================================
// Topic expansion for the within-chat pass (focus.ts).
//
// "how is pranjali's health" has to reach "Exhaustion and cold", "Already
// taking meds" and "MD medicine". None of them shares a token or a stem with
// the question, and the chats are Hindi, Marathi, English and Hinglish at once
// — an English-only synonym list is half a fix, so every cluster below carries
// the romanised spellings the corpus actually uses.
//
// WHY A CURATED MAP AND NOT THE ENCODER
//
// The bundled encoder is a bi-encoder over whole MESSAGES; there is no
// vocabulary index to take nearest neighbours of a word from, and building one
// is a second index for a job a table does. It also does not work here:
// measured on the real database with all 595 vectors built,
// "Exhaustion and cold" scores 0.63σ against this question corpus-wide and
// 0.82σ inside her own chat — 39th of 189 — behind "Your parents ?". The
// encoder earns its place finding paraphrase (semantic.ts); it does not find
// this.
//
// WHY THIS IS SAFE
//
// Expansion multiplies recall by ~10 and is only ever applied to ONE resolved
// chat. Corpus-wide it would drag in the pharmacy, the insurance helpline and a
// marketing broadcast called "Orange Health Updates" on every health question.
// Inside the chat the question already named, recall is close to free: the
// expanded match above returns 18 of her 234 messages and 17 of them are the
// illness thread.
// ===========================================================================

/**
 * Words that mean the same THING for retrieval, in the four languages these
 * chats are written in. Symmetric by construction — any member reaches every
 * other member — so "how is her cold" expands exactly as "how is her health"
 * does.
 *
 * One cluster, deliberately. Every word in it was checked against the real
 * corpus; a map padded with clusters nobody has typed is a map that cannot be
 * trusted where it matters. Adding a cluster is adding an array.
 */
const CLUSTERS: readonly (readonly string[])[] = [
  [
    // English
    "health", "healthy", "unwell", "sick", "ill", "illness", "sickness",
    "fever", "cold", "cough", "flu", "throat", "infection", "exhaustion",
    "exhausted", "doctor", "doctors", "clinic", "hospital", "medicine",
    "medicines", "meds", "antibiotic", "antibiotics", "prescription",
    "prescribe", "symptoms", "recovery", "recover",
    // Hindi / Hinglish
    "tabiyat", "tabiat", "tabyat", "bimar", "bimari", "beemar", "beemari",
    "dawa", "dawai", "dava", "davai", "goli", "bukhar", "sardi", "zukam",
    "khansi", "khaasi", "gala", "dard", "aaram", "thakan",
    // Marathi
    "aajari", "aajar", "tabyet", "औषध",
  ],
];

/**
 * Below this a prefix term matches half the chat and buys nothing that the
 * exact term did not already have. Same threshold query.ts uses.
 */
const MIN_PREFIX_CHARS = 5;

/** token -> the whole cluster it belongs to, built once. */
const INDEX = new Map<string, readonly string[]>();
for (const cluster of CLUSTERS) {
  for (const word of cluster) INDEX.set(word, cluster);
}

/** Every word this term is a synonym of, itself excluded. Empty for most terms. */
export function topicSiblings(term: string): string[] {
  const cluster = INDEX.get(term.toLowerCase());
  if (!cluster) return [];
  return cluster.filter((w) => w !== term.toLowerCase());
}

/**
 * The terms a within-chat search should look for, given what the question
 * asked. Order is stable so the MATCH expression a query produces is stable,
 * which is what makes a failure reproducible.
 */
export function expandTopics(terms: readonly string[]): string[] {
  const out: string[] = [];
  for (const term of terms) {
    for (const sibling of topicSiblings(term)) {
      if (!out.includes(sibling)) out.push(sibling);
    }
  }
  return out;
}

/**
 * Prefix terms for the expansion, so "antibiotic" also reaches "antibiotics"
 * and "bimar" reaches "bimari". Only for words long enough that the prefix is
 * still about the same thing.
 */
export function topicPrefixes(expanded: readonly string[]): string[] {
  const out: string[] = [];
  for (const word of expanded) {
    if (word.length < MIN_PREFIX_CHARS) continue;
    if (!/^[a-z][a-z-]*$/.test(word)) continue;
    if (!out.includes(word)) out.push(word);
  }
  return out;
}
