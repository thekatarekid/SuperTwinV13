// The embedding-model registry (V1 Part 8, task 5.4).
//
// One place that knows every encoder this build will run, what it costs to
// fetch, what its files must hash to, and the prefixes it was trained with. The
// bundled default stays `Xenova/multilingual-e5-small` — it ships inside the
// .app, it is 129 MB, and it is what keeps the installer lean. Everything else
// here is a ONE-TAP UPGRADE: a bigger encoder the user chooses, downloads and
// swaps to, with the old index still serving until the new one is built.
//
// Two rules this file exists to hold:
//
//   - EVERY file carries a pinned length and a pinned sha256. A truncated ONNX
//     graph does not fail loudly; it produces vectors in a space where nothing
//     looks wrong. So the download VERIFIES rather than trusts, and a mismatch
//     rejects the file. That is a supply-chain gate on a binary artifact — the
//     one thing code is allowed to reject. It is not a gate on model output.
//   - The prefixes are part of the model, not decoration. E5 is trained with
//     "query: "/"passage: " and scores measurably worse without them;
//     EmbeddingGemma is trained with its own task-prefixed format. Getting them
//     wrong is a silently worse index, so they live beside the digests.
//
// Digests and lengths below were read from huggingface.co at the pinned
// revision (the LFS oid IS the sha256 for the large files; the small ones were
// fetched and hashed). Nothing here is guessed.

import { getDb } from "../db/connection.js";

/** One weight file, and the bytes it must be for the model to load. */
export interface EmbeddingModelFile {
  /** Relative to the model's own directory, and its path in the HF repo. */
  path: string;
  bytes: number;
  sha256: string;
}

/** What produced a vector: recorded on every row so a change invalidates. */
export interface EmbeddingModelSpec {
  /** Stored in event_embeddings.model, and the directory the files live under. */
  id: string;
  dim: number;
  source: string;
  /** The commit the files are fetched from, pinned rather than a branch. */
  revision: string;
  files: readonly EmbeddingModelFile[];
  /**
   * E5 is trained with these prefixes and scores measurably worse without
   * them; they are part of the model, not decoration.
   */
  queryPrefix: string;
  passagePrefix: string;
  /** What the runtime is asked for. All four here are the int8 export. */
  dtype: string;

  // ---- Registry metadata (what Settings renders) --------------------------

  /** Short human name for the picker. */
  label: string;
  /** One sentence on what choosing it buys, and what it costs. */
  note: string;
  /**
   * True for the copy that ships inside the .app. Exactly one entry has it —
   * it is the only one that can be found under <resources>, and the only one
   * that must never be offered for download or delete.
   */
  bundled: boolean;
  /** The upgrade the card leads with. Exactly one entry has it. */
  recommended: boolean;
  /**
   * The repo the weights were EXPORTED FROM, when that is not `id`. Set only
   * for EmbeddingGemma: google/embeddinggemma-300m is a gated repo and carries
   * no ONNX weights, so the runnable artifact is the community ONNX export and
   * `id` has to be the repo the runtime can actually resolve.
   */
  upstream?: string;
}

// ---------------------------------------------------------------------------
// The catalogue.
// ---------------------------------------------------------------------------

/**
 * multilingual-e5-small: 12-layer XLM-R, 384 dims, 100+ languages including
 * Hindi and Marathi, and trained on romanised text — which is what Hinglish
 * is. int8 ONNX: measured to rank this corpus identically to fp32 at a quarter
 * of the size (118 MB against 448 MB).
 *
 * Every digest below is the sha256 huggingface.co serves for this revision.
 *
 * NOTE: this object is mutated by the route tests, which pin their own tiny
 * catalogue over it. It is therefore the same live object the registry array
 * holds — never a copy — so a test that rewrites `.files` rewrites what the
 * download manager reads.
 */
export const EMBEDDING_MODEL: EmbeddingModelSpec = {
  id: "Xenova/multilingual-e5-small",
  dim: 384,
  source: "https://huggingface.co/Xenova/multilingual-e5-small",
  revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
  files: [
    {
      path: "config.json",
      bytes: 658,
      sha256: "cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1",
    },
    {
      path: "tokenizer_config.json",
      bytes: 443,
      sha256: "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b",
    },
    {
      path: "tokenizer.json",
      bytes: 17_082_730,
      sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
    },
    {
      // What dtype "q8" resolves to. Naming it here rather than letting the
      // runtime choose keeps the downloaded set and the loaded set one set.
      path: "onnx/model_quantized.onnx",
      bytes: 118_308_185,
      sha256: "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193",
    },
  ],
  queryPrefix: "query: ",
  passagePrefix: "passage: ",
  dtype: "q8",
  label: "Multilingual E5 Small",
  note:
    "Ships inside the app. 384 dimensions, 100+ languages, fastest of the four " +
    "— and the only one that works with no network at all.",
  bundled: true,
  recommended: false,
};

/**
 * EmbeddingGemma 300M — the recommended upgrade.
 *
 * Best multilingual retrieval quality of anything under 500M parameters at the
 * time this was pinned, and it is 300M, so it stays a CPU model. 768 dims.
 *
 * `id` is the community ONNX export, not `google/embeddinggemma-300m`, for one
 * reason that is not negotiable: the Google repo is gated (manual approval) and
 * carries no ONNX weights, so nothing on this machine could fetch or run it.
 * `upstream` records what it IS, so the picker can name the model the user has
 * heard of rather than the mirror it came from.
 *
 * The weights are an external-data ONNX pair: the graph is 568 KB and the
 * tensors live beside it in `.onnx_data`. Both are pinned; a graph without its
 * data loads as nothing.
 */
export const EMBEDDING_MODEL_GEMMA: EmbeddingModelSpec = {
  id: "onnx-community/embeddinggemma-300m-ONNX",
  upstream: "google/embeddinggemma-300m",
  dim: 768,
  source: "https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX",
  revision: "5090578d9565bb06545b4552f76e6bc2c93e4a66",
  files: [
    {
      path: "config.json",
      bytes: 1_765,
      sha256: "6e1f06404b7163e0325ed2ea3e6781cde50f4a50b31780a95ad0d30e8404d77b",
    },
    {
      path: "tokenizer_config.json",
      bytes: 1_156_830,
      sha256: "3ca953eea6c3c9fcda9cf3df22949ff18b216f7c74bd6459230f3f1013953f3a",
    },
    {
      path: "special_tokens_map.json",
      bytes: 662,
      sha256: "2f7b0adf4fb469770bb1490e3e35df87b1dc578246c5e7e6fc76ecf33213a397",
    },
    {
      path: "added_tokens.json",
      bytes: 35,
      sha256: "50b2f405ba56a26d4913fd772089992252d7f942123cc0a034d96424221ba946",
    },
    {
      path: "tokenizer.json",
      bytes: 20_323_312,
      sha256: "4dda02faaf32bc91031dc8c88457ac272b00c1016cc679757d1c441b248b9c47",
    },
    {
      path: "onnx/model_quantized.onnx",
      bytes: 567_874,
      sha256: "172efde319fe1542dc41f31be6154910b05b78f7a861c265c4600eec906bd6d8",
    },
    {
      // The tensors. The graph above is a 568 KB index into this.
      path: "onnx/model_quantized.onnx_data",
      bytes: 308_890_624,
      sha256: "705626e28e4c23c82ade34566b4197d97f534c12275fa406dfb71e9937d388c0",
    },
  ],
  // EmbeddingGemma's trained retrieval format. Asymmetric on purpose: the
  // query side names the task, the document side names the (absent) title.
  queryPrefix: "task: search result | query: ",
  passagePrefix: "title: none | text: ",
  dtype: "q8",
  label: "EmbeddingGemma 300M",
  note:
    "Google's multilingual retrieval model — the best quality under 500M " +
    "parameters. 768 dimensions, and slower per message than the bundled one. " +
    "Benchmark it on your own messages before you swap.",
  bundled: false,
  recommended: true,
};

/** The same family as the bundled default, two sizes up. 768 dims. */
export const EMBEDDING_MODEL_E5_BASE: EmbeddingModelSpec = {
  id: "Xenova/multilingual-e5-base",
  dim: 768,
  source: "https://huggingface.co/Xenova/multilingual-e5-base",
  revision: "1ec9243030a27d1a115d5c340572074c125b58b2",
  files: [
    {
      path: "config.json",
      bytes: 686,
      sha256: "4c27930e59106027abab56f7531c1fa6b14bbf31e8229ec36d68affa4e869bcd",
    },
    {
      path: "tokenizer_config.json",
      bytes: 418,
      sha256: "efb5c0d09722e5fe59a462cd2a9976ee216d55b037597d997cd3fe833216da15",
    },
    {
      path: "tokenizer.json",
      bytes: 17_082_660,
      sha256: "62c24cdc13d4c9952d63718d6c9fa4c287974249e16b7ade6d5a85e7bbb75626",
    },
    {
      path: "onnx/model_quantized.onnx",
      bytes: 278_647_662,
      sha256: "df7a9a29309e3ad491e1783adf8baee710262cc06079c7cbab63c630277fac94",
    },
  ],
  queryPrefix: "query: ",
  passagePrefix: "passage: ",
  dtype: "q8",
  label: "Multilingual E5 Base",
  note:
    "The bundled model's bigger sibling. Same prefixes, same languages, 768 " +
    "dimensions — a safe step up with no change in behaviour.",
  bundled: false,
  recommended: false,
};

/** Max quality, max cost. 1024 dims, 8k context, and 560 MB on disk. */
export const EMBEDDING_MODEL_BGE_M3: EmbeddingModelSpec = {
  id: "Xenova/bge-m3",
  dim: 1024,
  source: "https://huggingface.co/Xenova/bge-m3",
  revision: "4de13258303883538bd53b696b452bf8099f0858",
  files: [
    {
      path: "config.json",
      bytes: 770,
      sha256: "734a79bf12d388c1467a4e3ab625f45de7f6906cffcfb93a1eca1787504bed95",
    },
    {
      path: "tokenizer_config.json",
      bytes: 1_173,
      sha256: "7e4c1cc848840aeccdd763458c18dd525eb0f795c992e00ebe9c28554e7db2d4",
    },
    {
      path: "tokenizer.json",
      bytes: 17_082_821,
      sha256: "6710678b12670bc442b99edc952c4d996ae309a7020c1fa0096dd245c2faf790",
    },
    {
      path: "onnx/model_quantized.onnx",
      bytes: 569_694_530,
      sha256: "0826f8c1ab9edf1801db86c61919d4d108e8bfc0b809ec823ad366882ff0b77d",
    },
  ],
  // BGE-M3 is trained WITHOUT instruction prefixes; adding one hurts it.
  queryPrefix: "",
  passagePrefix: "",
  dtype: "q8",
  label: "BGE-M3",
  note:
    "The largest of the four: 1024 dimensions and an 8k window, so a long " +
    "forwarded message survives whole. Slowest, and 560 MB on disk.",
  bundled: false,
  recommended: false,
};

/**
 * The catalogue, in the order the picker shows it: bundled first (it is the
 * default and the fallback), then the recommendation, then the rest by size.
 */
export const EMBEDDING_MODELS: readonly EmbeddingModelSpec[] = [
  EMBEDDING_MODEL,
  EMBEDDING_MODEL_GEMMA,
  EMBEDDING_MODEL_E5_BASE,
  EMBEDDING_MODEL_BGE_M3,
];

/**
 * The DEFAULT encoder: EmbeddingGemma 300M.
 *
 * It used to be the bundled E5 Small, and that was the wrong default — E5
 * Small is what ships so that a cold machine with no network can still answer,
 * not what this build wants to be running. Gemma is the better retriever on
 * the corpus this app indexes, and it is what a fresh install is steered onto:
 * the registry reports it as the default, Settings leads with it, and
 * `adoptDefaultEmbeddingModel()` (retrieval/default-model.ts) moves an install
 * onto it the moment its weights are on disk — through the background swap
 * when there is already an index to re-embed.
 */
export const DEFAULT_EMBEDDING_MODEL_ID = EMBEDDING_MODEL_GEMMA.id;

/**
 * The encoder that ships INSIDE the .app, and therefore the only one that can
 * answer with no network at all. It is what `activeEmbeddingModelId()` falls
 * back to, because that function's contract is "never returns something the
 * runtime cannot load" — and on a fresh install the default's weights are not
 * here yet.
 */
export const BUNDLED_EMBEDDING_MODEL_ID = EMBEDDING_MODEL.id;

export function listEmbeddingModels(): readonly EmbeddingModelSpec[] {
  return EMBEDDING_MODELS;
}

/** The spec with this id, or null. Ids are catalogue keys, never user strings. */
export function findEmbeddingModel(id: string | null | undefined): EmbeddingModelSpec | null {
  if (!id) return null;
  return EMBEDDING_MODELS.find((m) => m.id === id) ?? null;
}

/** What the whole model costs to fetch. */
export function embeddingModelSpecBytes(spec: EmbeddingModelSpec): number {
  return spec.files.reduce((n, f) => n + f.bytes, 0);
}

// ---------------------------------------------------------------------------
// Which one is active.
//
// Stored in app_state rather than a column, for the same reason every other
// switch is: it is one string, and the tables that matter already carry
// (model, dim) on every row, so the setting is a POINTER into an index that
// describes itself.
// ---------------------------------------------------------------------------

export const ACTIVE_EMBEDDING_MODEL_KEY = "retrieval.embedding_model";

/** The stored choice, or null when nothing valid is stored. */
export function storedEmbeddingModelId(): string | null {
  try {
    const row = getDb()
      .prepare(`SELECT value FROM app_state WHERE key = ?`)
      .get(ACTIVE_EMBEDDING_MODEL_KEY) as { value: string | null } | undefined;
    return findEmbeddingModel(row?.value)?.id ?? null;
  } catch {
    // No database yet (early boot, a unit test).
    return null;
  }
}

/**
 * The active model's id. Falls back to the BUNDLED encoder for every reading
 * that is not a catalogue id — no stored value, an id from a build that
 * offered a model this one does not, a hand-edited row.
 *
 * Note the fallback is the bundled one and NOT `DEFAULT_EMBEDDING_MODEL_ID`:
 * the default is what this build wants to run, the bundled one is what it can
 * always run, and this function's contract is that there is no state in which
 * it returns something the runtime cannot load. Moving an install from the one
 * to the other is `adoptDefaultEmbeddingModel()`'s job, and it only does it
 * once the weights are actually here.
 */
export function activeEmbeddingModelId(): string {
  return storedEmbeddingModelId() ?? BUNDLED_EMBEDDING_MODEL_ID;
}

/** The active spec. Never null, for the reason above. */
export function activeEmbeddingModel(): EmbeddingModelSpec {
  return findEmbeddingModel(activeEmbeddingModelId()) ?? EMBEDDING_MODEL;
}

/**
 * Point the index at another model. Rejects an id that is not in the catalogue
 * — that is a bad ARGUMENT, not a judgement about anything a model said.
 *
 * This is the LAST step of a swap, never the first: writing it before the new
 * vectors exist is what would leave search answering out of an empty index.
 */
export function setActiveEmbeddingModelId(id: string): void {
  const spec = findEmbeddingModel(id);
  if (!spec) throw new Error(`unknown embedding model: ${id}`);
  getDb()
    .prepare(
      `INSERT INTO app_state (key, value, updated_at)
       VALUES (@key, @value, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run({ key: ACTIVE_EMBEDDING_MODEL_KEY, value: spec.id });
}
