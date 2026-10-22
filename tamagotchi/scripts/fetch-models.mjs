// Stages the on-device face model + MediaPipe wasm into public/mediapipe/.
// Everything face-related runs in the browser; nothing here talks to an AI API.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "mediapipe");
const wasmSrc = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const MODEL_PATH = join(outDir, "face_landmarker.task");
// Pinned so a changed upstream file is noticed instead of silently used.
const MODEL_SHA256 = process.env.FACE_MODEL_SHA256 ?? "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff";

mkdirSync(outDir, { recursive: true });

if (!existsSync(wasmSrc)) {
  console.error("[models] @mediapipe/tasks-vision is not installed — run `npm install` first.");
  process.exit(1);
}
cpSync(wasmSrc, join(outDir, "wasm"), { recursive: true });

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

if (existsSync(MODEL_PATH) && sha(readFileSync(MODEL_PATH)) === MODEL_SHA256) {
  process.exit(0);
}

console.log("[models] downloading face_landmarker.task (~3.6 MB, one time)…");
const res = await fetch(MODEL_URL);
if (!res.ok) {
  console.error(`[models] download failed: HTTP ${res.status}`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
const got = sha(buf);
if (got !== MODEL_SHA256) {
  console.error(`[models] checksum mismatch (got ${got}). Set FACE_MODEL_SHA256 to override if Google updated the file.`);
  process.exit(1);
}
writeFileSync(MODEL_PATH, buf);
console.log("[models] ready");
