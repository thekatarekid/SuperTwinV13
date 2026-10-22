import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { cleanName, parseSelection } from "../shared/options.ts";
import { GenerationBudget } from "./budget.ts";
import { buildMascotPrompt } from "./prompt.ts";
import { ProviderError, sniffImageMime, type ImageProvider } from "./providers/types.ts";

export interface AppOptions {
  provider: ImageProvider;
  budget: GenerationBudget;
  /** Built UI to serve (production). Omit in dev — Vite serves the UI. */
  staticDir?: string;
  maxConcurrent?: number;
  timeoutMs?: number;
}

const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".task": "application/octet-stream",
  ".woff2": "font/woff2",
};

export function createApp(opts: AppOptions) {
  const maxConcurrent = opts.maxConcurrent ?? opts.provider.maxConcurrent ?? 2;
  const timeoutMs = opts.timeoutMs ?? opts.provider.timeoutMs ?? 150_000;
  let inFlight = 0;

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/api/health" && req.method === "GET") {
        return sendJson(res, 200, {
          ok: true,
          provider: opts.provider.id,
          label: opts.provider.label,
          demo: opts.provider.id === "mock",
          local: opts.provider.id === "local",
        });
      }

      if (url.pathname === "/api/mascot") {
        if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST" });
        return await handleMascot(req, res);
      }

      if (url.pathname.startsWith("/api/")) return sendJson(res, 404, { error: "Not found" });
      if (opts.staticDir && (req.method === "GET" || req.method === "HEAD")) return serveStatic(opts.staticDir, url.pathname, res);
      return sendJson(res, 404, { error: "Not found" });
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      console.error("[server] unexpected error", err);
      return sendJson(res, 500, { error: "Something went wrong on our side." });
    }
  };

  async function handleMascot(req: IncomingMessage, res: ServerResponse) {
    if (!(req.headers["content-type"] ?? "").includes("application/json")) {
      throw new HttpError(415, "Send JSON");
    }
    const body = await readJson(req);
    const photo = decodePhoto((body as { photo?: unknown }).photo);
    const sel = parseSelection((body as { options?: unknown }).options);
    if (!sel.ok) throw new HttpError(400, sel.error);
    const name = cleanName((body as { name?: unknown }).name);

    if (inFlight >= maxConcurrent) throw new HttpError(429, "Already generating — wait for the current one to finish.");
    if (opts.provider.billable) {
      const denied = opts.budget.take();
      if (denied) throw new HttpError(429, denied);
    }

    const prompt = buildMascotPrompt(sel.value, { compact: opts.provider.compactPrompt });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    req.on("close", () => {
      if (!res.writableEnded) ctrl.abort();
    });
    inFlight++;
    const started = Date.now();
    try {
      const out = await opts.provider.generate({
        photo: photo.bytes,
        photoMime: photo.mime,
        prompt,
        selection: sel.value,
        signal: ctrl.signal,
      });
      // The photo is never written anywhere: it lives only in this request.
      return sendJson(res, 200, {
        image: `data:${out.mime};base64,${out.image.toString("base64")}`,
        provider: opts.provider.id,
        model: opts.provider.model,
        name,
        ms: Date.now() - started,
      });
    } catch (err) {
      if (err instanceof ProviderError) throw new HttpError(err.status, err.message);
      if (ctrl.signal.aborted) throw new HttpError(504, "The image service took too long. Try again.");
      console.error("[server] provider failure", err);
      throw new HttpError(502, "Couldn't reach the image service. Check your connection and try again.");
    } finally {
      clearTimeout(timer);
      inFlight--;
    }
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function decodePhoto(value: unknown): { bytes: Buffer; mime: string } {
  if (typeof value !== "string") throw new HttpError(400, "photo must be a data URL");
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!m) throw new HttpError(400, "photo must be a JPEG, PNG or WebP data URL");
  const bytes = Buffer.from(m[2], "base64");
  if (bytes.length > MAX_PHOTO_BYTES) throw new HttpError(413, "Photo is too large (max 8 MB)");
  const sniffed = sniffImageMime(bytes);
  if (!sniffed) throw new HttpError(400, "photo is not a valid image");
  return { bytes, mime: sniffed };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function serveStatic(dir: string, pathname: string, res: ServerResponse) {
  const root = resolve(dir);
  let file = normalize(join(root, decodeURIComponent(pathname)));
  if (!file.startsWith(root)) return sendJson(res, 403, { error: "Forbidden" });
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html"); // SPA fallback
  if (!existsSync(file)) return sendJson(res, 404, { error: "Build the UI first: npm run build" });
  res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}
