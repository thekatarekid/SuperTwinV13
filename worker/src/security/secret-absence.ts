import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export const SECRET_SCAN_MAX_FILES = 10_000;
export const SECRET_SCAN_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const SECRET_SCAN_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export interface SecretScanFinding {
  file: string;
  secret: string;
  encoding: "plain" | "url" | "base64" | "base64url" | "json-unicode" | "utf16le" | "utf16be";
}

export interface SecretScanResult {
  files: number;
  bytes: number;
  findings: SecretScanFinding[];
}

export interface SecretScanOptions {
  roots: string[];
  /** Name -> exact synthetic/runtime value. Names are safe to report; values are not. */
  secrets: Record<string, string>;
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  /** Deterministic audit/test instrumentation after the no-follow descriptor is verified. */
  onFileOpened?: (path: string) => void;
  /** Deterministic audit/test instrumentation during directory enumeration. */
  onDirectoryOpened?: (path: string) => void;
}

function encodedNeedles(secrets: Record<string, string>): Array<{
  name: string; value: string; encoding: SecretScanFinding["encoding"];
}> {
  const needles: Array<{ name: string; value: string; encoding: SecretScanFinding["encoding"] }> = [];
  for (const [name, value] of Object.entries(secrets)) {
    if (value.length < 8) throw new Error(`secret scan value ${name} is too short`);
    needles.push({ name, value, encoding: "plain" });
    const url = encodeURIComponent(value);
    if (url !== value) {
      needles.push({ name, value: url, encoding: "url" });
      needles.push({ name, value: url.replace(/%[0-9A-F]{2}/g, (part) => part.toLowerCase()), encoding: "url" });
    }
    const base64 = Buffer.from(value, "utf8").toString("base64");
    needles.push({ name, value: base64, encoding: "base64" });
    needles.push({ name, value: base64.replace(/=+$/, ""), encoding: "base64" });
    const base64url = base64.replace(/\+/g, "-").replace(/\//g, "_");
    needles.push({ name, value: base64url, encoding: "base64url" });
    needles.push({ name, value: base64url.replace(/=+$/, ""), encoding: "base64url" });
    needles.push({ name, value: [...value].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""), encoding: "json-unicode" });
  }
  return needles;
}

/** Deterministic bounded scan. It never follows symlinks or prints secret values. */
export function scanSecretAbsence(options: SecretScanOptions): SecretScanResult {
  const maxFiles = options.maxFiles ?? SECRET_SCAN_MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? SECRET_SCAN_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? SECRET_SCAN_MAX_TOTAL_BYTES;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 ||
      !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 ||
      !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1) {
    throw new Error("invalid secret scan bounds");
  }
  const needles = encodedNeedles(options.secrets);
  const pending = [...new Set(options.roots.map((root) => resolve(root)))].sort().reverse();
  const findings: SecretScanFinding[] = [];
  let files = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const path = pending.pop()!;
    let stat;
    try { stat = lstatSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      options.onDirectoryOpened?.(path);
      const children = readdirSync(path).sort().reverse();
      const after = lstatSync(path);
      if (!after.isDirectory() || after.dev !== stat.dev || after.ino !== stat.ino || after.mtimeMs !== stat.mtimeMs) {
        throw new Error("secret scan directory changed during traversal");
      }
      for (const child of children) pending.push(resolve(path, child));
      continue;
    }
    if (!stat.isFile()) continue;
    files += 1;
    if (files > maxFiles) throw new Error("secret scan file limit exceeded");
    if (stat.size > maxFileBytes) throw new Error("secret scan per-file limit exceeded");
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) {
      if (["ELOOP", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw error;
    }
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino || before.size > maxFileBytes) {
        throw new Error("secret scan file changed before read");
      }
      options.onFileOpened?.(path);
      const chunks: Buffer[] = [];
      let fileBytes = 0;
      while (true) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxFileBytes + 1 - fileBytes));
        if (chunk.length === 0) throw new Error("secret scan per-file limit exceeded");
        const count = readSync(fd, chunk, 0, chunk.length, null);
        if (count === 0) break;
        fileBytes += count;
        if (fileBytes > maxFileBytes || bytes + fileBytes > maxTotalBytes) throw new Error("secret scan byte limit exceeded");
        chunks.push(chunk.subarray(0, count));
      }
      const after = fstatSync(fd);
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || fileBytes !== before.size || after.mtimeMs !== before.mtimeMs) {
        throw new Error("secret scan file changed during read");
      }
      bytes += fileBytes;
      const body = Buffer.concat(chunks, fileBytes);
      const utf8 = body.toString("utf8");
      const views: Array<{ text: string; encoding?: "utf16le" | "utf16be" }> = [
        { text: utf8 },
        { text: utf8.replace(/%[0-9a-f]{2}/gi, (part) => part.toUpperCase()) },
        { text: utf8.replace(/\\u([0-9a-f]{4})/gi, (_part, hex: string) => `\\u${hex.toLowerCase()}`) },
      ];
      for (const offset of [0, 1]) {
        const length = body.length - offset - ((body.length - offset) % 2);
        if (length <= 0) continue;
        const aligned = body.subarray(offset, offset + length);
        views.push({ text: aligned.toString("utf16le"), encoding: "utf16le" });
        const swapped = Buffer.from(aligned); swapped.swap16();
        views.push({ text: swapped.toString("utf16le"), encoding: "utf16be" });
      }
      for (const needle of needles) for (const view of views) {
        if (view.text.includes(needle.value)) findings.push({
          file: path, secret: needle.name, encoding: view.encoding ?? needle.encoding,
        });
      }
    } finally { closeSync(fd); }
  }
  return { files, bytes, findings };
}

export function assertSecretsAbsent(options: SecretScanOptions): SecretScanResult {
  const result = scanSecretAbsence(options);
  if (result.findings.length > 0) {
    const safe = result.findings.map((finding) =>
      `${finding.secret}:${finding.encoding}@${finding.file}`).join(", ");
    throw new Error(`secret material found: ${safe}`);
  }
  return result;
}
