import type { Selection } from "../../shared/options.ts";

export interface GenerateInput {
  /** Cropped, face-centred photo from the browser (JPEG/PNG/WebP bytes). */
  photo: Buffer;
  photoMime: string;
  prompt: string;
  selection: Selection;
  signal: AbortSignal;
}

export interface GenerateOutput {
  image: Buffer;
  mime: string;
}

export interface ImageProvider {
  id: "pollinations" | "gemini" | "local" | "mock";
  /** Human label for the UI ("Pollinations · Nano Banana 2"). */
  label: string;
  model: string;
  /** True when a call costs money/credits (drives the budget guard). */
  billable: boolean;
  /** Parallel generations allowed (local models: 1). */
  maxConcurrent?: number;
  /** Per-generation timeout override. */
  timeoutMs?: number;
  /** Small models truncate long prompts — send the short form. */
  compactPrompt?: boolean;
  generate(input: GenerateInput): Promise<GenerateOutput>;
}

/** An error whose message is safe and useful to show the user. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}
