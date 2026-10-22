import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ProviderError, sniffImageMime, type GenerateInput, type ImageProvider } from "./types.ts";

// 100% local and free: FLUX.2 Klein 4B (Apache-2.0 open weights) running on
// Apple Silicon through MFLUX (MLX). First run downloads the weights (~15 GB,
// once). 8-bit quantization keeps it comfortable on a 16 GB Mac.

export const MFLUX_BIN = "mflux-generate-flux2-edit";
export const MFLUX_DEFAULT_MODEL = "flux2-klein-4b";

export interface MfluxOptions {
  bin?: string;
  model?: string;
  quantize?: number;
  steps?: number;
  lowRam?: boolean;
  /** Test seam: replaces the child-process runner. */
  run?: (bin: string, args: string[], signal: AbortSignal) => Promise<{ code: number; log: string }>;
}

export function mfluxArgs(o: { model: string; input: string; output: string; prompt: string; seed: number; quantize: number; steps: number; lowRam: boolean }): string[] {
  return [
    "--model", o.model,
    "--image-paths", o.input,
    "--prompt", o.prompt,
    "--steps", String(o.steps),
    "--seed", String(o.seed),
    "--width", "1024",
    "--height", "1024",
    "--quantize", String(o.quantize),
    "--output", o.output,
    ...(o.lowRam ? ["--low-ram"] : []),
  ];
}

export function mfluxProvider(opts: MfluxOptions = {}): ImageProvider {
  const bin = opts.bin ?? MFLUX_BIN;
  const model = opts.model ?? MFLUX_DEFAULT_MODEL;
  const run = opts.run ?? runChild;
  return {
    id: "local",
    label: `On this Mac · ${model} (free)`,
    model,
    billable: false,
    maxConcurrent: 1, // one generation at a time — it uses most of the RAM
    timeoutMs: 20 * 60_000, // the very first run also downloads the weights
    compactPrompt: true,
    async generate({ photo, photoMime, prompt, signal }: GenerateInput) {
      const dir = await mkdtemp(join(tmpdir(), "herogotchi-"));
      try {
        const input = join(dir, `face.${photoMime === "image/png" ? "png" : photoMime === "image/webp" ? "webp" : "jpg"}`);
        const output = join(dir, "hero.png");
        await writeFile(input, photo);
        const args = mfluxArgs({
          model,
          input,
          output,
          prompt,
          seed: Math.floor(Math.random() * 2 ** 31),
          quantize: opts.quantize ?? 8,
          steps: opts.steps ?? 4,
          lowRam: opts.lowRam ?? false,
        });
        let result: { code: number; log: string };
        try {
          result = await run(bin, args, signal);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            throw new ProviderError("MFLUX isn't installed. Run `npm run setup:local` (macOS on Apple Silicon only).", 500);
          }
          throw err;
        }
        if (signal.aborted) throw new ProviderError("Generation cancelled.", 499);
        if (result.code !== 0) {
          const tail = result.log.trim().split("\n").slice(-3).join(" ").slice(-300);
          const oom = /memory|Metal|killed/i.test(result.log);
          throw new ProviderError(
            oom
              ? "Your Mac ran out of memory. Close other apps, or set MFLUX_LOW_RAM=1 / MFLUX_QUANTIZE=4 in .env."
              : `Local generation failed: ${tail || `exit code ${result.code}`}`,
            500,
          );
        }
        const image = await readFile(output).catch(() => null);
        const mime = image && sniffImageMime(image);
        if (!image || !mime) throw new ProviderError("Local generation produced no image.", 500);
        return { image, mime };
      } finally {
        // Your photo never outlives the request, even locally.
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

function runChild(bin: string, args: string[], signal: AbortSignal): Promise<{ code: number; log: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    const keep = (b: Buffer) => {
      const text = b.toString();
      log = (log + text).slice(-8000);
      process.stdout.write(`[mflux] ${text}`);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const onAbort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", reject);
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      resolve({ code: code ?? 1, log });
    });
  });
}

/** True when the MFLUX command is on PATH (used to auto-select local mode). */
export function mfluxInstalled(bin = MFLUX_BIN, pathEnv = process.env.PATH ?? ""): boolean {
  return pathEnv.split(delimiter).some((dir) => dir && existsSync(join(dir, bin)));
}
