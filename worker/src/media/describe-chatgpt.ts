import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderInputItem } from "../providers/types.js";
import { prepareVisionImage } from "./batch.js";

/** Leaves 100 KiB beneath request.ts's 1 MiB absolute serialized-body bound. */
export const CHATGPT_MEDIA_CHUNK_BYTES = 900 * 1024;
/** Base64 expands by 4/3; this keeps one encoded image below the chunk rail. */
export const CHATGPT_MEDIA_MAX_IMAGE_BYTES = 560 * 1024;
export const CHATGPT_MEDIA_MAX_IMAGES_PER_CHUNK = 8;
const CHATGPT_MEDIA_IMAGE_BUDGET_BYTES = 768 * 1024;
const CHATGPT_MEDIA_MAX_SOURCE_BYTES = 16 * 1024 * 1024;

export interface ChatGptMediaImage {
  readonly id: string;
  readonly path: string;
}

export interface ChatGptMediaChunk {
  readonly ids: readonly string[];
  readonly input: readonly ProviderInputItem[];
  readonly encodedBytes: number;
}

export class ChatGptMediaEncodingError extends Error {
  constructor(message: string, readonly code: "CAPABILITY_UNSUPPORTED" | "CANCELLED" | "TIMEOUT" = "CAPABILITY_UNSUPPORTED") {
    super(message);
    this.name = "ChatGptMediaEncodingError";
  }
}

function mimeFor(path: string, bytes: Uint8Array): string {
  const extension = path.toLowerCase().match(/\.(jpe?g|png|gif|webp)$/)?.[1];
  const prefix = Buffer.from(bytes.subarray(0, 12));
  const magic = prefix.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? "png"
    : bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
        bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9 ? "jpeg"
      : (prefix.subarray(0, 6).toString("ascii") === "GIF87a" ||
          prefix.subarray(0, 6).toString("ascii") === "GIF89a") ? "gif"
        : String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP" ? "webp"
          : null;
  const normalizedExtension = extension === "jpg" ? "jpeg" : extension;
  if (!magic || magic !== normalizedExtension) {
    throw new ChatGptMediaEncodingError("the image content does not match its supported file type");
  }
  if (magic === "jpeg") return "image/jpeg";
  if (magic === "png") return "image/png";
  if (magic === "gif") return "image/gif";
  if (magic === "webp") return "image/webp";
  throw new ChatGptMediaEncodingError("the selected image format cannot be encoded for ChatGPT");
}

function cancellation(signal?: AbortSignal): ChatGptMediaEncodingError {
  return new ChatGptMediaEncodingError(
    signal?.reason instanceof DOMException && signal.reason.name === "TimeoutError"
      ? "ChatGPT media preparation timed out"
      : "ChatGPT media preparation was cancelled",
    signal?.reason instanceof DOMException && signal.reason.name === "TimeoutError" ? "TIMEOUT" : "CANCELLED",
  );
}

async function encodeImage(image: ChatGptMediaImage, signal?: AbortSignal): Promise<{
  id: string;
  path: string;
  url: string;
  bytes: number;
}> {
  if (signal?.aborted) throw cancellation(signal);
  const size = await stat(image.path);
  if (!size.isFile() || size.size <= 0 || size.size > CHATGPT_MEDIA_MAX_IMAGE_BYTES) {
    throw new ChatGptMediaEncodingError("the prepared image exceeds the ChatGPT media limit");
  }
  let data: Buffer;
  try {
    data = await readFile(image.path, { signal });
  } catch (error) {
    if (signal?.aborted) throw cancellation(signal);
    throw error;
  }
  if (signal?.aborted) throw cancellation(signal);
  const mime = mimeFor(image.path, data);
  const url = `data:${mime};base64,${data.toString("base64")}`;
  return { ...image, url, bytes: Buffer.byteLength(url, "utf8") };
}

async function prepareBoundedImage(
  image: ChatGptMediaImage,
  tempRoot: string,
  index: number,
  signal?: AbortSignal,
): Promise<ChatGptMediaImage> {
  const source = await stat(image.path);
  if (!source.isFile() || source.size <= 0 || source.size > CHATGPT_MEDIA_MAX_SOURCE_BYTES) {
    throw new ChatGptMediaEncodingError("the source image exceeds the local preparation limit");
  }
  let sourceBytes: Buffer;
  try {
    sourceBytes = await readFile(image.path, { signal });
  } catch (error) {
    if (signal?.aborted) throw cancellation(signal);
    throw error;
  }
  mimeFor(image.path, sourceBytes);
  if (source.size <= CHATGPT_MEDIA_MAX_IMAGE_BYTES) return image;
  for (const edge of [1092, 896, 768, 640, 512, 384, 256]) {
    if (signal?.aborted) throw cancellation(signal);
    const outputPath = join(tempRoot, `${index}-${edge}.jpg`);
    let prepared;
    try {
      prepared = await prepareVisionImage(image.path, {
        maxEdge: edge,
        signal,
        outputPath,
        forceEncode: true,
      });
    } catch {
      if (signal?.aborted) throw cancellation(signal);
      throw new ChatGptMediaEncodingError("the image could not be prepared for ChatGPT");
    }
    if (prepared.path === image.path) continue;
    const candidate = await stat(prepared.path);
    if (candidate.size > 0 && candidate.size <= CHATGPT_MEDIA_MAX_IMAGE_BYTES) {
      // encodeImage performs the independent magic/MIME validation.
      return { ...image, path: prepared.path };
    }
  }
  throw new ChatGptMediaEncodingError("the prepared image exceeds the ChatGPT media limit");
}

function withoutPaths(prompt: string, images: readonly ChatGptMediaImage[]): string {
  let safe = prompt;
  for (const image of images) safe = safe.split(image.path).join(`attached image ${image.id}`);
  return safe;
}

/** Read and encode bounded images, then partition them without changing order. */
export async function buildChatGptMediaChunks(
  prompt: string | ((images: readonly ChatGptMediaImage[]) => string),
  images: readonly ChatGptMediaImage[],
  signal?: AbortSignal,
): Promise<readonly ChatGptMediaChunk[]> {
  if (images.length === 0) throw new ChatGptMediaEncodingError("ChatGPT media input is empty");
  const seen = new Set<string>();
  for (const image of images) {
    if (!/^#[0-9]{2,3}$/.test(image.id) || seen.has(image.id)) {
      throw new ChatGptMediaEncodingError("ChatGPT media ids must be unique ordered markers");
    }
    seen.add(image.id);
  }
  const tempRoot = await mkdtemp(join(tmpdir(), "supertwin-chatgpt-media-"));
  const encoded = [] as Awaited<ReturnType<typeof encodeImage>>[];
  try {
    for (const [index, image] of images.entries()) {
      encoded.push(await encodeImage(await prepareBoundedImage(image, tempRoot, index, signal), signal));
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  const chunks: ChatGptMediaChunk[] = [];
  for (let at = 0; at < encoded.length;) {
    const chosen: typeof encoded = [];
    let encodedBytes = 0;
    while (at < encoded.length && chosen.length < CHATGPT_MEDIA_MAX_IMAGES_PER_CHUNK) {
      const candidate = encoded[at]!;
      if (chosen.length > 0 && encodedBytes + candidate.bytes > CHATGPT_MEDIA_IMAGE_BUDGET_BYTES) break;
      if (candidate.bytes > CHATGPT_MEDIA_IMAGE_BUDGET_BYTES) {
        throw new ChatGptMediaEncodingError("the prepared image exceeds the ChatGPT request limit");
      }
      chosen.push(candidate);
      encodedBytes += candidate.bytes;
      at += 1;
    }
    const selectedImages = chosen.map(({ id, path }) => ({ id, path }));
    const chunkPrompt = typeof prompt === "function" ? prompt(selectedImages) : prompt;
    const content: ProviderInputItem = {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: withoutPaths(chunkPrompt, images) },
        ...chosen.flatMap((image) => [
          { type: "input_text" as const, text: `Attached image ${image.id}` },
          { type: "input_image" as const, image_url: image.url, detail: "auto" as const },
        ]),
      ],
    };
    if (Buffer.byteLength(JSON.stringify([content]), "utf8") > CHATGPT_MEDIA_CHUNK_BYTES) {
      throw new ChatGptMediaEncodingError("the prepared media request exceeds the ChatGPT request limit");
    }
    chunks.push(Object.freeze({ ids: Object.freeze(chosen.map((image) => image.id)), input: Object.freeze([content]), encodedBytes }));
  }
  return Object.freeze(chunks);
}
