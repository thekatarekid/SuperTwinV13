import { mkdtempSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildChatGptMediaChunks,
  CHATGPT_MEDIA_MAX_IMAGE_BYTES,
  ChatGptMediaEncodingError,
} from "./describe-chatgpt.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function image(name: string, bytes: Uint8Array = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])): string {
  const root = mkdtempSync(join(tmpdir(), "st-chatgpt-media-"));
  roots.push(root);
  const path = join(root, name);
  writeFileSync(path, bytes);
  return path;
}

describe("ChatGPT media encoder", () => {
  it("emits data URLs only, removes local paths, and preserves image/id order", async () => {
    const first = image("first.jpg");
    const second = image("second.png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const chunks = await buildChatGptMediaChunks(
      `Read ${first} then ${second}`,
      [{ id: "#01", path: first }, { id: "#02", path: second }],
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.ids).toEqual(["#01", "#02"]);
    const encoded = JSON.stringify(chunks[0]!.input);
    expect(encoded).not.toContain(first);
    expect(encoded).not.toContain(second);
    expect(encoded.indexOf("Attached image #01")).toBeLessThan(encoded.indexOf("Attached image #02"));
    expect(encoded).toContain("data:image/jpeg;base64,");
    expect(encoded).toContain("data:image/png;base64,");
  });

  it("chunks deterministically without reordering or duplicating ids", async () => {
    const images = Array.from({ length: 9 }, (_, index) => ({
      id: `#${String(index + 1).padStart(2, "0")}`,
      path: image(`${index}.jpg`),
    }));
    const chunks = await buildChatGptMediaChunks("Describe every image", images);
    expect(chunks.map((chunk) => chunk.ids.length)).toEqual([8, 1]);
    expect(chunks.flatMap((chunk) => chunk.ids)).toEqual(images.map(({ id }) => id));
  });

  it("keeps a decodable PNG near the binary boundary below the serialized request rail", async () => {
    const onePixelPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const padded = Buffer.concat([
      onePixelPng,
      Buffer.alloc(CHATGPT_MEDIA_MAX_IMAGE_BYTES - onePixelPng.length),
    ]);
    const chunks = await buildChatGptMediaChunks("describe", [{ id: "#01", path: image("near.png", padded) }]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.encodedBytes).toBeLessThan(900 * 1024);
  });

  it("recompresses a real oversized image batch into owned derivatives and cleans them up", async () => {
    const width = 800;
    const height = 800;
    const priorFfmpeg = process.env.SUPERTWIN_FFMPEG_BIN;
    const ffmpeg = join(process.cwd(), "..", "src-tauri", "resources", "bin", "ffmpeg");
    process.env.SUPERTWIN_FFMPEG_BIN = ffmpeg;
    const source = image("large.png");
    const secondSource = image("large-2.png");
    execFileSync(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
      `nullsrc=s=${width}x${height}`, "-vf", "noise=alls=100", "-frames:v", "1", source,
    ]);
    execFileSync(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
      `nullsrc=s=${width}x${height}`, "-vf", "noise=alls=100", "-frames:v", "1", secondSource,
    ]);
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith("supertwin-chatgpt-media-")).sort();
    const chunks = await buildChatGptMediaChunks(`describe ${source} and ${secondSource}`, [
      { id: "#01", path: source }, { id: "#02", path: secondSource },
    ]).finally(() => {
      if (priorFfmpeg === undefined) delete process.env.SUPERTWIN_FFMPEG_BIN;
      else process.env.SUPERTWIN_FFMPEG_BIN = priorFfmpeg;
    });
    const after = readdirSync(tmpdir()).filter((name) => name.startsWith("supertwin-chatgpt-media-")).sort();
    expect(JSON.stringify(chunks[0]!.input)).toContain("data:image/jpeg;base64,");
    expect(JSON.stringify(chunks)).not.toContain(source);
    expect(JSON.stringify(chunks)).not.toContain(secondSource);
    expect(chunks.flatMap((chunk) => chunk.ids)).toEqual(["#01", "#02"]);
    expect(chunks.every((chunk) => chunk.encodedBytes < 768 * 1024)).toBe(true);
    expect(after).toEqual(before);
  });

  it("fails oversized, unsupported, duplicate-id, and cancelled work before a request exists", async () => {
    const huge = image("huge.jpg");
    truncateSync(huge, CHATGPT_MEDIA_MAX_IMAGE_BYTES + 1);
    await expect(buildChatGptMediaChunks("x", [{ id: "#01", path: huge }]))
      .rejects.toBeInstanceOf(ChatGptMediaEncodingError);
    await expect(buildChatGptMediaChunks("x", [{ id: "#01", path: image("bad.heic", Uint8Array.of(1, 2, 3)) }]))
      .rejects.toBeInstanceOf(ChatGptMediaEncodingError);
    await expect(buildChatGptMediaChunks("x", [{
      id: "#01",
      path: image("spoof.jpg", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1])),
    }])).rejects.toBeInstanceOf(ChatGptMediaEncodingError);
    const duplicate = image("duplicate.jpg");
    await expect(buildChatGptMediaChunks("x", [{ id: "#01", path: duplicate }, { id: "#01", path: duplicate }]))
      .rejects.toBeInstanceOf(ChatGptMediaEncodingError);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(buildChatGptMediaChunks("x", [{ id: "#01", path: duplicate }], controller.signal))
      .rejects.toMatchObject({ code: "CANCELLED" });
  });
});
