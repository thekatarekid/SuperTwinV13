// ===========================================================================
// A CONSTRUCTED reference corpus for embedder-calibration tests (build item
// 0.7): vectors with the geometry `multilingual-e5-small` actually produces on
// real chat text, without shipping 100 MB of ONNX weights into a unit test.
//
// The property being reproduced is the one that makes calibration necessary at
// all (arch §10.3 ¶1): unrelated text does NOT score ~0. Every vector here is
//
//     normalize( √wShared · u  +  √wTopic · t_k  +  √wNoise · r )
//
// where `u` is one axis every document shares (the "this is chat in this
// language" direction), `t_k` is one of `topics` topic axes, and `r` is that
// document's own noise. Random unit vectors in 384 dimensions are near
// orthogonal, so two documents on DIFFERENT topics land at cos ≈ wShared —
// the floor — and two on the SAME topic land at cos ≈ wShared + wTopic.
//
// With the defaults that is a ~0.80 floor and ~0.92 for genuinely related
// pairs, which is exactly the band the architecture measured on real e5.
// ===========================================================================

export interface ReferenceCorpusOptions {
  /** How many documents. Default 400 — enough for >1,000 distinct pairs. */
  count?: number;
  dim?: number;
  /**
   * How many topics the corpus splits into. More topics = fewer genuinely
   * related pairs in a random draw (1/topics of them), which is what a real
   * corpus looks like.
   */
  topics?: number;
  seed?: number;
  /** Weight of the axis EVERY document shares. This becomes the floor. */
  sharedWeight?: number;
  /** Weight of the topic axis — what related pairs have and others do not. */
  topicWeight?: number;
  noiseWeight?: number;
}

export interface ReferenceCorpus {
  vectors: Float32Array[];
  /** Topic index per vector, so a test can pick a genuinely related pair. */
  topicOf: number[];
  dim: number;
}

const DEFAULTS = {
  count: 400,
  dim: 384,
  topics: 40,
  seed: 20260815,
  sharedWeight: 0.8,
  topicWeight: 0.12,
  noiseWeight: 0.08,
};

/** Deterministic PRNG — the same corpus on every machine and every run. */
export function rng(seed: number): () => number {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(next: () => number): number {
  // Box–Muller. `1 - next()` keeps the log away from 0.
  const u = 1 - next();
  const v = next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function randomUnit(dim: number, next: () => number): Float32Array {
  const v = new Float32Array(dim);
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    v[i] = gaussian(next);
    norm += v[i] * v[i];
  }
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < dim; i++) v[i] *= inv;
  return v;
}

/** Build the corpus. Same options in, byte-identical vectors out. */
export function referenceCorpus(opts: ReferenceCorpusOptions = {}): ReferenceCorpus {
  const o = { ...DEFAULTS, ...opts };
  const next = rng(o.seed);
  const shared = randomUnit(o.dim, next);
  const topicAxes = Array.from({ length: o.topics }, () => randomUnit(o.dim, next));

  const cShared = Math.sqrt(o.sharedWeight);
  const cTopic = Math.sqrt(o.topicWeight);
  const cNoise = Math.sqrt(o.noiseWeight);

  const vectors: Float32Array[] = [];
  const topicOf: number[] = [];
  for (let d = 0; d < o.count; d++) {
    const topic = d % o.topics;
    const noise = randomUnit(o.dim, next);
    const v = new Float32Array(o.dim);
    let norm = 0;
    for (let i = 0; i < o.dim; i++) {
      v[i] = cShared * shared[i] + cTopic * topicAxes[topic][i] + cNoise * noise[i];
      norm += v[i] * v[i];
    }
    const inv = 1 / Math.sqrt(norm);
    for (let i = 0; i < o.dim; i++) v[i] *= inv;
    vectors.push(v);
    topicOf.push(topic);
  }
  return { vectors, topicOf, dim: o.dim };
}

/** Two vectors from the SAME topic — a genuinely related pair. */
export function relatedPair(corpus: ReferenceCorpus): [Float32Array, Float32Array] {
  const first = 0;
  const second = corpus.topicOf.findIndex((t, i) => i !== first && t === corpus.topicOf[first]);
  return [corpus.vectors[first], corpus.vectors[second]];
}
