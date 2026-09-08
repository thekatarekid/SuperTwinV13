// ===========================================================================
// Media reader tests (vitest): the spec §8 strategy table (which file gets
// opened for which kind/mime, and what is refused outright), the prompt the
// model is given, and how a CLI outcome becomes a recordable verdict.
//
// The provider is a stub — no `claude` is ever spawned. Real files are written
// into a temp media root so the existence check sees what it expects.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb } from "../db/connection.js";
import { runMigrations } from "../db/index.js";
import type { PendingMediaRow } from "../db/ingest.js";
import { setSelectedModel } from "../db/settings.js";
import type {
  NeutralProviderResult,
  ProviderAuthState,
  ProviderCapabilities,
  ProviderId,
  ProviderModel,
  ProviderModelCatalogue,
  ProviderRequest,
  ProviderV2,
} from "../providers/types.js";
import { emptyUsage } from "../providers/usage.js";
import { ProviderGateError } from "../providers/gate.js";
import { verifyEcho } from "./batch.js";
import {
  BATCH_MARKER,
  batchImageId,
  buildBatchPrompt,
  buildFramesPrompt,
  buildPrompt,
  describeMedia,
  describeMediaBatch,
  MAX_DESCRIPTION_CHARS,
  mediaRoot,
  mediaStrategy,
  parseBatchAnswer,
} from "./describe.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-media-describe-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  process.env.SUPERTWIN_HOME = tmpDir;
  closeDb();
  runMigrations();
  mkdirSync(join(tmpDir, "media"), { recursive: true });
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_HOME;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A real file under the media root, so existsSync agrees it is readable. */
function file(name: string): string {
  const path = join(tmpDir, "media", name);
  writeFileSync(path, "x");
  return path;
}

function row(overrides: Partial<PendingMediaRow> = {}): PendingMediaRow {
  return {
    id: "wa:alice@x/IMG",
    kind: "image",
    mediaPath: "/media/alice/IMG.jpg",
    thumbPath: null,
    mime: "image/jpeg",
    filename: "IMG_2201.jpg",
    seconds: null,
    caption: null,
    ...overrides,
  };
}

/** Provider stub: records every send and replies with `reply`. */
function stubProvider(
  reply: string,
  status: NeutralProviderResult["status"] = "ok",
  id: ProviderId = "claude-local",
  modelOverrides: Partial<ProviderModel> = {},
): ProviderV2 & { calls: ProviderRequest[] } {
  const calls: ProviderRequest[] = [];
  const capabilities: ProviderCapabilities = {
    functionTools: false,
    hostTools: id === "claude-local",
    continuation: id === "claude-local",
    requiresAuthentication: false,
  };
  const model = (modelId: string, isDefault: boolean): ProviderModel => ({
    id: modelId,
    displayName: modelId,
    isDefault,
    hidden: false,
    inputModalities: ["text"],
    reasoningValues: ["off"],
    defaultReasoning: "off",
    supportsTools: false,
    supportsHostTools: id === "claude-local",
    supportsParallelToolCalls: false,
    supportsStructuredOutput: false,
    supportsStrictTools: false,
    supportsVerbosity: false,
    supportsPromptCacheKey: false,
    supportsPromptCacheOptions: false,
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    billingLabel: null,
    ...modelOverrides,
  });
  return {
    id,
    displayName: "Media fixture",
    capabilities,
    calls,
    cancel: () => false,
    killAll: () => {},
    authState(): ProviderAuthState {
      return { status: "ready", error: null };
    },
    catalogue(): ProviderModelCatalogue {
      return {
        providerId: id,
        mode: "discovered",
        source: "media-test",
        discoveredAt: "2026-09-08T00:00:00.000Z",
        revision: `media-test-${id}`,
        error: null,
        models: [
          model(id === "claude-local" ? "claude-haiku-4-5-20251001" : "gpt-media", true),
          model("claude-opus-4-5-20251101", false),
        ],
      };
    },
    async send(opts: ProviderRequest): Promise<NeutralProviderResult> {
      calls.push(opts);
      if (reply.length) opts.onEvent({ type: "delta", text: reply });
      if (status === "error") {
        opts.onEvent({ type: "error", code: "CLI_ERROR", message: "boom" });
      }
      return {
        continuation: null,
        usage: { ...emptyUsage(), inputTokens: 10, outputTokens: 20 },
        freshFallback: false,
        status,
        errorCode: status === "error" ? "CLI_ERROR" : undefined,
      };
    },
  };
}

function requestText(request: ProviderRequest): string {
  const item = request.input[0];
  if (item?.type !== "message") return "";
  const content = item.content[0];
  return content?.type === "input_text" ? content.text : "";
}

describe("mediaStrategy (spec §8 table)", () => {
  it("images and stickers are read directly", () => {
    expect(mediaStrategy(row())).toEqual({
      kind: "image",
      path: "/media/alice/IMG.jpg",
    });
    expect(mediaStrategy(row({ kind: "sticker" }))).toMatchObject({
      kind: "image",
    });
  });

  it("a video is read through its one thumbnail frame", () => {
    expect(
      mediaStrategy(row({ kind: "video", thumbPath: "/media/alice/V.thumb.jpg" })),
    ).toEqual({ kind: "frame", path: "/media/alice/V.thumb.jpg" });
  });

  it("a video with no frame is unsupported — the clip itself is unreadable", () => {
    expect(mediaStrategy(row({ kind: "video" })).kind).toBe("unsupported");
  });

  it("pdf / json / text mimes are readable documents", () => {
    for (const mime of [
      "application/pdf",
      "application/json",
      "text/plain; charset=utf-8",
      "text/markdown",
    ]) {
      expect(
        mediaStrategy(row({ kind: "document", mime, filename: "f" })).kind,
      ).toBe("document");
    }
  });

  it("an unknown mime falls back to the extension", () => {
    const known = row({
      kind: "document",
      mime: "application/octet-stream",
      filename: "notes.md",
    });
    expect(mediaStrategy(known).kind).toBe("document");
    expect(
      mediaStrategy({ ...known, filename: "sheet.xlsx" }).kind,
    ).toBe("unsupported");
    expect(mediaStrategy({ ...known, filename: "noext" }).kind).toBe(
      "unsupported",
    );
  });

  it("audio and unknown kinds are never read", () => {
    expect(mediaStrategy(row({ kind: "audio" })).kind).toBe("unsupported");
    expect(mediaStrategy(row({ kind: "location" })).kind).toBe("unsupported");
  });

  it("a row with no file is unsupported whatever its kind claims", () => {
    expect(mediaStrategy(row({ mediaPath: null })).kind).toBe("unsupported");
    expect(
      mediaStrategy(row({ kind: "document", mediaPath: null, mime: "text/plain" }))
        .kind,
    ).toBe("unsupported");
  });
});

describe("buildPrompt", () => {
  it("names the exact file and asks for verbatim text", () => {
    const p = buildPrompt(row(), { kind: "image", path: "/media/alice/IMG.jpg" });
    expect(p).toContain("/media/alice/IMG.jpg");
    expect(p).toContain("verbatim");
    expect(p).toContain("IMG_2201.jpg");
  });

  it("a video frame carries the caption and the clip duration", () => {
    const p = buildPrompt(
      row({ kind: "video", caption: "the goal", seconds: 42 }),
      { kind: "frame", path: "/media/alice/V.thumb.jpg" },
    );
    expect(p).toContain("the goal");
    expect(p).toContain("42s");
    expect(p).toContain("one frame");
  });

  it("a document is asked for its title and gist", () => {
    const p = buildPrompt(row({ kind: "document" }), {
      kind: "document",
      path: "/media/alice/D.pdf",
    });
    expect(p).toContain("title");
  });
});

describe("buildFramesPrompt", () => {
  it("names every frame with its offset and asks for the clip, not the stills", () => {
    const p = buildFramesPrompt(
      row({ kind: "video", filename: "VID_88.mp4", caption: "dekho", seconds: 20 }),
      [
        { path: "/media/alice/V.frame0.jpg", seconds: 2.5 },
        { path: "/media/alice/V.frame1.jpg", seconds: 7.5 },
        { path: "/media/alice/V.frame2.jpg", seconds: 12.5 },
      ],
    );
    expect(p).toContain("/media/alice/V.frame0.jpg — at 2.5s");
    expect(p).toContain("/media/alice/V.frame2.jpg — at 12.5s");
    expect(p).toContain("VID_88.mp4");
    expect(p).toContain("dekho");
    expect(p).toContain("20s");
    // The whole point of one call: a sequence, not three unrelated pictures.
    expect(p).toContain("ONE");
    expect(p).toContain("what changes");
    expect(p).toContain("verbatim");
  });
});

describe("describeMedia", () => {
  it("reads the file with only the Read tool, from the media root", async () => {
    const provider = stubProvider("A whiteboard reading Q3 LAUNCH.");
    const res = await describeMedia(row({ mediaPath: file("IMG.jpg") }), {
      provider,
      runId: "media-wa:alice@x/IMG",
    });

    expect(res).toMatchObject({
      description: "A whiteboard reading Q3 LAUNCH.",
      status: "done",
      error: null,
    });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].hostTools).toEqual(["Read"]);
    expect(provider.calls[0].toolChoice).toBe("auto");
    expect(provider.calls[0].instructions).toBe("");
    expect(provider.calls[0].cwd).toBe(mediaRoot());
    expect(provider.calls[0].runId).toBe("media-wa:alice@x/IMG");
    expect(res.promptChars).toBe(requestText(provider.calls[0]).length);
    expect(provider.calls[0].maxOutputTokens).toBe(8_192);
  });

  it("never loads the user's global CLAUDE.md", async () => {
    const provider = stubProvider("ok");
    await describeMedia(row({ mediaPath: file("IMG.jpg") }), { provider });
    expect(provider.calls[0].skipHostSettings).toBe(true);
  });

  it("uses the model selected for the media role", async () => {
    const provider = stubProvider("ok");
    setSelectedModel("media", "claude-opus-4-5-20251101");
    const res = await describeMedia(row({ mediaPath: file("IMG.jpg") }), {
      provider,
    });
    expect(provider.calls[0].model).toBe("claude-opus-4-5-20251101");
    expect(res.model).toBe("claude-opus-4-5-20251101");
  });

  it("preserves the exact packed prompt inside one strict text input", async () => {
    const provider = stubProvider("ok");
    const path = file("EXACT.jpg");
    const media = row({ mediaPath: path });
    await describeMedia(media, { provider });

    expect(requestText(provider.calls[0])).toBe(
      buildPrompt(media, { kind: "image", path }),
    );
    expect(Object.hasOwn(provider.calls[0], "tools")).toBe(false);
    expect(Object.hasOwn(provider.calls[0], "continuation")).toBe(false);
  });

  it("selects but fails the ChatGPT data-URL route until P4b-B, without fallback", async () => {
    const provider = stubProvider("invented caption", "ok", "chatgpt-oauth", {
      supportsHostTools: true,
      inputModalities: ["text", "image"],
    });
    const result = await describeMedia(row({ mediaPath: file("IMG-chatgpt.jpg") }), {
      provider,
    });

    expect(result).toMatchObject({
      status: "error",
      provider: "chatgpt-oauth",
      model: "gpt-media",
      errorCode: "CAPABILITY_UNSUPPORTED",
    });
    expect(result.error).toContain("P4b-B");
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects a ChatGPT model without advertised image input before send", async () => {
    const provider = stubProvider("invented caption", "ok", "chatgpt-oauth");
    const result = await describeMedia(row({ mediaPath: file("IMG-text-only.jpg") }), {
      provider,
    });
    expect(result).toMatchObject({
      status: "error",
      provider: "chatgpt-oauth",
      model: "gpt-media",
      errorCode: "CAPABILITY_UNSUPPORTED",
    });
    expect(result.error).toContain("does not advertise image input");
    expect(provider.calls).toHaveLength(0);
  });

  it("fails before send when the Claude model lacks Read or an output bound", async () => {
    for (const modelOverrides of [
      { supportsHostTools: false },
      { maxOutputTokens: null },
    ] satisfies Partial<ProviderModel>[]) {
      const provider = stubProvider("invented caption", "ok", "claude-local", modelOverrides);
      const result = await describeMedia(row({ mediaPath: file(`IMG-${provider.calls.length}.jpg`) }), {
        provider,
      });
      expect(result.errorCode).toBe("CAPABILITY_UNSUPPORTED");
      expect(provider.calls).toHaveLength(0);
    }
  });

  it("keeps a thrown provider admission failure typed for queue routing", async () => {
    const provider = stubProvider("never");
    provider.send = async () => {
      throw new ProviderGateError("AUTH_REQUIRED");
    };
    const result = await describeMedia(row({ mediaPath: file("AUTH.jpg") }), {
      provider,
    });

    expect(result).toMatchObject({
      status: "error",
      provider: "claude-local",
      errorCode: "AUTH_REQUIRED",
    });
  });

  it("an unsupported type is never sent to the model and never described", async () => {
    const provider = stubProvider("a plausible-sounding invention");
    for (const r of [
      row({ kind: "audio", mediaPath: file("VOICE.ogg") }),
      row({ kind: "video", mediaPath: file("CLIP.mp4") }),
      row({
        kind: "document",
        mediaPath: file("BOOK.docx"),
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename: "BOOK.docx",
      }),
    ]) {
      const res = await describeMedia(r, { provider });
      expect(res.status).toBe("unsupported");
      expect(res.description).toBeNull();
      expect(res.error).toBeTruthy();
    }
    expect(provider.calls).toHaveLength(0);
  });

  it("a file that is gone is skipped, not retried forever", async () => {
    const provider = stubProvider("ok");
    const res = await describeMedia(row({ mediaPath: join(tmpDir, "gone.jpg") }), {
      provider,
    });
    expect(res.status).toBe("skipped");
    expect(res.description).toBeNull();
    expect(res.error).toContain("gone.jpg");
    expect(provider.calls).toHaveLength(0);
  });

  it("a CLI failure comes back as a retryable error carrying the message", async () => {
    const provider = stubProvider("", "error");
    const res = await describeMedia(row({ mediaPath: file("IMG.jpg") }), {
      provider,
    });
    expect(res).toMatchObject({
      description: null,
      status: "error",
      error: "boom",
    });
  });

  it("an empty answer is an error, not an empty description", async () => {
    const provider = stubProvider("   \n  ");
    const res = await describeMedia(row({ mediaPath: file("IMG.jpg") }), {
      provider,
    });
    expect(res.status).toBe("error");
    expect(res.description).toBeNull();
  });

  it("a fenced answer is unwrapped and a runaway one is capped", async () => {
    const fenced = stubProvider("```\nA photo of a dog.\n```");
    expect(
      (await describeMedia(row({ mediaPath: file("IMG.jpg") }), { provider: fenced }))
        .description,
    ).toBe("A photo of a dog.");

    const long = stubProvider("word ".repeat(2000));
    const res = await describeMedia(row({ mediaPath: file("IMG.jpg") }), {
      provider: long,
    });
    expect(res.description!.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
  });
});

/** N real image rows under the media root, ready to be batched. */
function images(n: number): PendingMediaRow[] {
  return Array.from({ length: n }, (_, i) =>
    row({
      id: `wa:alice@x/IMG${i}`,
      mediaPath: file(`IMG${i}.jpg`),
      filename: `IMG_${i}.jpg`,
    }),
  );
}

/** The answer a well-behaved model gives for `rows`. */
/** A well-formed answer: every id the prompt issued, echoed back exactly once. */
function batchAnswer(rows: PendingMediaRow[], ids?: string[]): string {
  return rows
    .map((r, i) => `${BATCH_MARKER} ${ids?.[i] ?? batchImageId(i)}\nA photo of ${r.id}.`)
    .join("\n\n");
}

describe("describeMedia with sampled frames", () => {
  it("reads every frame in ONE call, with turns enough to open them all", async () => {
    const provider = stubProvider("A market stall; the seller hands over a bag.");
    const frames = [0, 1, 2, 3].map((i) => ({
      path: file(`V.frame${i}.jpg`),
      seconds: 2.5 + i * 5,
    }));

    const res = await describeMedia(
      row({ kind: "video", mediaPath: file("V.mp4"), thumbPath: file("V.thumb.jpg") }),
      { provider, frames },
    );

    expect(res).toMatchObject({ status: "done", error: null });
    expect(provider.calls).toHaveLength(1);
    for (const frame of frames) {
      expect(requestText(provider.calls[0])).toContain(frame.path);
    }
    // ...and the thumbnail it supersedes is not in the prompt at all.
    expect(requestText(provider.calls[0])).not.toContain("V.thumb.jpg");
    expect(provider.calls[0].maxAgentTurns).toBeGreaterThan(frames.length);
  });

  it("falls back to the single thumbnail when sampling produced nothing", async () => {
    const provider = stubProvider("one still");
    const thumb = file("V2.thumb.jpg");
    await describeMedia(
      row({ kind: "video", mediaPath: file("V2.mp4"), thumbPath: thumb }),
      { provider, frames: [] },
    );
    expect(requestText(provider.calls[0])).toContain(thumb);
    expect(requestText(provider.calls[0])).toContain("one still frame");
  });

  it("ignores a frame the sweep already took rather than naming a missing file", async () => {
    const provider = stubProvider("two frames");
    const kept = file("V3.frame0.jpg");
    await describeMedia(row({ kind: "video", mediaPath: file("V3.mp4") }), {
      provider,
      frames: [
        { path: kept, seconds: 2.5 },
        { path: join(tmpDir, "media", "V3.frame1.jpg"), seconds: 7.5 },
      ],
    });
    expect(requestText(provider.calls[0])).toContain(kept);
    expect(requestText(provider.calls[0])).not.toContain("V3.frame1.jpg");
    expect(requestText(provider.calls[0])).toContain("these 1 still frames");
  });

  it("a video with frames but no thumbnail is readable, where before it was not", async () => {
    const provider = stubProvider("the clip");
    const res = await describeMedia(
      row({ kind: "video", mediaPath: file("V4.mp4"), thumbPath: null }),
      { provider, frames: [{ path: file("V4.frame0.jpg"), seconds: 1 }] },
    );
    expect(res.status).toBe("done");
  });
});

describe("buildBatchPrompt", () => {
  it("lists every path with an explicit id and demands each block be stamped with one", () => {
    const rows = images(3);
    const p = buildBatchPrompt(
      rows.map((r) => ({ row: r, path: r.mediaPath as string })),
    );
    for (const r of rows) expect(p).toContain(r.mediaPath);
    for (const id of ["#01", "#02", "#03"]) expect(p).toContain(id);
    expect(p).toContain("Read each of these 3 files");
    expect(p).toContain(BATCH_MARKER);
    // The whole-set rule is stated to the model, not only enforced after it.
    expect(p).toContain("exactly once — all 3 of them");
    expect(p).toContain("UNREADABLE");
  });

  it("detaches the id from the path and forbids anything after it on the marker line", () => {
    const rows = images(2);
    const p = buildBatchPrompt(
      rows.map((r) => ({ row: r, path: r.mediaPath as string })),
    );
    // The id is on its own line — rendered as `#01 /long/path` the model reads
    // the two as one token and echoes both back as the id.
    expect(p).toContain("id #01\n    file:");
    expect(p).toContain(`${BATCH_MARKER} #NN`);
    expect(p).toContain("NOTHING\nfollows it on that line");
    // A worked example, and the ban on a preamble turn.
    expect(p).toContain(`So a block for id #01 looks exactly like this:\n\n${BATCH_MARKER} #01`);
    expect(p).toContain("Do not write anything at");
  });
});

describe("parseBatchAnswer", () => {
  it("keys descriptions by id, never by position", () => {
    const parsed = parseBatchAnswer(
      `${BATCH_MARKER} #02\nThe second one.\n\n${BATCH_MARKER} #01\nThe first one.`,
      ["#01", "#02"],
    );
    expect(parsed.blocks.get("#01")).toBe("The first one.");
    expect(parsed.blocks.get("#02")).toBe("The second one.");
    expect(parsed.returned).toEqual(["#02", "#01"]);
  });

  it("tolerates a backticked or colon-trailed id and a fenced answer", () => {
    const parsed = parseBatchAnswer(
      "```\n" + `${BATCH_MARKER} \`#01\`:\nSeen.\n` + "```",
      ["#01"],
    );
    expect(parsed.blocks.get("#01")).toBe("Seen.");
  });

  it("normalises a missing hash or leading zero — the ids are ours and none collide", () => {
    const parsed = parseBatchAnswer(`${BATCH_MARKER} 1\nSeen.\n${BATCH_MARKER} #2\nAlso.`, [
      "#01",
      "#02",
    ]);
    expect(parsed.blocks.get("#01")).toBe("Seen.");
    expect(parsed.blocks.get("#02")).toBe("Also.");
    expect(parsed.returned).toEqual(["#01", "#02"]);
  });

  it("reports an id named twice rather than merging or dropping it silently", () => {
    const parsed = parseBatchAnswer(
      `${BATCH_MARKER} #01\nOne.\n${BATCH_MARKER} #01\nTwo.`,
      ["#01"],
    );
    // The caller is what rejects it: `returned` is what the echo check reads.
    expect(parsed.returned).toEqual(["#01", "#01"]);
    expect(verifyEcho(["#01"], parsed.returned).matched).toBe(false);
  });

  it("reports an id nobody asked about, and carries no block for it", () => {
    const parsed = parseBatchAnswer(
      `Sure, here you go.\n${BATCH_MARKER} #09\nNot ours.\n` +
        `${BATCH_MARKER} #01\nReal.`,
      ["#01", "#02"],
    );
    expect([...parsed.blocks.keys()]).toEqual(["#01"]);
    expect(parsed.returned).toEqual(["#09", "#01"]);
    expect(verifyEcho(["#01", "#02"], parsed.returned)).toMatchObject({
      matched: false,
      missing: ["#02"],
      unexpected: ["#09"],
    });
  });

  // ---- The three answer shapes that rejected six real, CORRECT runs -------
  // Every string below is what the CLI actually returned; the model's answers
  // were right each time and the parser threw them away.

  it("mode A: an id with the file's path appended is still that id", () => {
    const parsed = parseBatchAnswer(
      `${BATCH_MARKER} #01 /Users/adityakatare/SuperTwinV13/media/whatsapp/` +
        `120363258303310545@g.us/3AAF3432BD790FBD3EFE.jpg\nA photo.\n` +
        `${BATCH_MARKER} #02\nAnother.`,
      ["#01", "#02"],
    );
    expect(parsed.returned).toEqual(["#01", "#02"]);
    expect(parsed.blocks.get("#01")).toBe("A photo.");
    expect(verifyEcho(["#01", "#02"], parsed.returned).matched).toBe(true);
  });

  it("mode A: a bare filename with no #NN is matched back by basename", () => {
    const parsed = parseBatchAnswer(
      `${BATCH_MARKER} 3AAF3432BD790FBD3EFE.jpg\nA photo.\n` +
        `${BATCH_MARKER} 3EB0C1D2.jpg\nAnother.`,
      ["#01", "#02"],
      [
        { id: "#01", paths: ["/media/whatsapp/g.us/3AAF3432BD790FBD3EFE.jpg"] },
        { id: "#02", paths: ["/media/whatsapp/g.us/3EB0C1D2.jpg"] },
      ],
    );
    expect(parsed.returned).toEqual(["#01", "#02"]);
    expect(parsed.blocks.get("#01")).toBe("A photo.");
    expect(parsed.blocks.get("#02")).toBe("Another.");
  });

  it("a filename that merely starts with digits is NOT read as an id", () => {
    // `12.jpg` must not become #12 — a caption filed against the wrong photo
    // is the one outcome worse than rejecting the batch.
    const parsed = parseBatchAnswer(`${BATCH_MARKER} 12.jpg\nA photo.`, ["#12"]);
    expect(parsed.returned).toEqual(["12.jpg"]);
    expect(verifyEcho(["#12"], parsed.returned).matched).toBe(false);
  });

  it("mode B: a preamble glued onto the first marker no longer destroys it", () => {
    // The preamble turn and the first answer turn were concatenated with no
    // separator, so the first marker was mid-line and the line-anchored parser
    // dropped a correct description on the floor.
    const parsed = parseBatchAnswer(
      `I'll read all 16 image files for you.${BATCH_MARKER} #01\nThe first one.\n\n` +
        `${BATCH_MARKER} #02\nThe second one.`,
      ["#01", "#02"],
    );
    expect(parsed.returned).toEqual(["#01", "#02"]);
    expect(parsed.blocks.get("#01")).toBe("The first one.");
    expect(parsed.blocks.get("#02")).toBe("The second one.");
    expect(verifyEcho(["#01", "#02"], parsed.returned).matched).toBe(true);
  });

  it("mode C: a duplicated block is reported symmetrically, never half-swallowed", () => {
    // A leaked duplicate assistant block glues a second copy on with no
    // separator. This is still a mismatch — the answer really does name every
    // id twice — but BOTH copies are now seen, where before the duplicate's
    // #01 was destroyed and only its stray #02 survived ("3 of 2 ids").
    const one = `${BATCH_MARKER} #01\nThe first one.\n${BATCH_MARKER} #02\nThe second one.`;
    const parsed = parseBatchAnswer(`${one}${one}`, ["#01", "#02"]);
    expect(parsed.returned).toEqual(["#01", "#02", "#01", "#02"]);
    expect(verifyEcho(["#01", "#02"], parsed.returned)).toMatchObject({
      matched: false,
      missing: [],
      unexpected: ["#01", "#02"],
    });
    // The first copy's descriptions are intact, so the split retry is the only
    // cost — no correct answer is silently lost.
    expect(parsed.blocks.get("#01")).toBe("The first one.");
  });

  it("reports the marker lines it actually saw, for the run log", () => {
    const parsed = parseBatchAnswer(
      `${BATCH_MARKER} #01 /very/long/path.jpg\nA photo.`,
      ["#01"],
    );
    expect(parsed.markers).toEqual([`${BATCH_MARKER} #01 /very/long/path.jpg`]);
  });

  it("an UNREADABLE block echoes its id but carries no description", () => {
    const parsed = parseBatchAnswer(
      `${BATCH_MARKER} #01\nA photo.\n${BATCH_MARKER} #02\nUNREADABLE`,
      ["#01", "#02"],
    );
    expect(parsed.blocks.get("#02")).toBeNull();
    // The id set is still complete, so the batch is not thrown away over it.
    expect(verifyEcho(["#01", "#02"], parsed.returned).matched).toBe(true);
  });
});

describe("describeMediaBatch", () => {
  it("reads eight images in one call and maps each answer to its own file", async () => {
    const rows = images(8);
    const provider = stubProvider(batchAnswer(rows));
    const batch = await describeMediaBatch(rows, { provider, runId: "media-batch-1" });

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].skipHostSettings).toBe(true);
    expect(provider.calls[0].hostTools).toEqual(["Read"]);
    for (const r of rows) {
      expect(batch.results.get(r.id)).toMatchObject({
        description: `A photo of ${r.id}.`,
        status: "done",
        error: null,
      });
    }
    expect(batch.call).toMatchObject({
      status: "done",
      promptChars: requestText(provider.calls[0]).length,
    });
  });

  it("fails the whole ChatGPT batch closed before any provider send", async () => {
    const rows = images(3);
    const provider = stubProvider(batchAnswer(rows), "ok", "chatgpt-oauth", {
      supportsHostTools: true,
      inputModalities: ["text", "image"],
    });
    const batch = await describeMediaBatch(rows, { provider });

    expect(provider.calls).toHaveLength(0);
    expect(batch.call).toMatchObject({
      status: "error",
      provider: "chatgpt-oauth",
      errorCode: "CAPABILITY_UNSUPPORTED",
    });
    for (const row of rows) {
      expect(batch.results.get(row.id)).toMatchObject({
        status: "error",
        errorCode: "CAPABILITY_UNSUPPORTED",
      });
    }
  });

  it("an answer missing one block is rejected WHOLE — the two that did line up are not applied", async () => {
    const rows = images(3);
    // The middle id is never echoed, so every block after it is suspect.
    const provider = stubProvider(
      `${BATCH_MARKER} #01\nA photo of ${rows[0].id}.\n\n${BATCH_MARKER} #03\nA photo of ${rows[2].id}.`,
    );
    const batch = await describeMediaBatch(rows, { provider });

    expect(batch.results.size).toBe(0);
    expect(batch.echo).toMatchObject({ matched: false, missing: ["#02"] });
    expect(batch.call.status).toBe("error");
    expect(batch.call.error).toContain("echoed 2 of 3 ids");
  });

  it("two ids that differ reject the batch rather than being matched up by position", async () => {
    const rows = images(16);
    const answer = batchAnswer(
      rows,
      rows.map((_, i) => (i < 14 ? batchImageId(i) : `#9${i}`)),
    );
    const batch = await describeMediaBatch(rows, { provider: stubProvider(answer) });

    expect(batch.results.size).toBe(0);
    expect(batch.echo).toMatchObject({
      matched: false,
      missing: ["#15", "#16"],
      unexpected: ["#914", "#915"],
    });
  });

  it("a preamble turn and a path-suffixed id are both answered, not rejected", async () => {
    // The exact shape of the runs that cost ~22% of the media spend: correct
    // descriptions, thrown away over the marker's punctuation.
    const rows = images(3);
    const provider = stubProvider(
      `I'll read all 3 image files for you.${BATCH_MARKER} #01 ${rows[0].mediaPath}\n` +
        `A photo of ${rows[0].id}.\n\n` +
        `${BATCH_MARKER} #02\nA photo of ${rows[1].id}.\n\n` +
        `${BATCH_MARKER} ${rows[2].filename}\nA photo of ${rows[2].id}.`,
    );
    const batch = await describeMediaBatch(rows, { provider });

    expect(batch.echo).toMatchObject({ matched: true });
    for (const r of rows) {
      expect(batch.results.get(r.id)).toMatchObject({
        description: `A photo of ${r.id}.`,
        status: "done",
      });
    }
  });

  it("a genuinely wrong answer is still rejected, and the error names the markers", async () => {
    const rows = images(3);
    const provider = stubProvider(
      `${BATCH_MARKER} #01\nA photo.\n\n${BATCH_MARKER} #07\nNot ours.`,
    );
    const batch = await describeMediaBatch(rows, { provider });

    expect(batch.results.size).toBe(0);
    expect(batch.echo).toMatchObject({ matched: false, unexpected: ["#07"] });
    expect(batch.call.error).toContain("echoed 2 of 3 ids");
    // The sample is what makes this diagnosable from extraction_runs alone.
    expect(batch.call.error).toContain(`markers: ${BATCH_MARKER} #01 | ${BATCH_MARKER} #07`);
  });

  it("an answer that names nothing we asked about maps no image at all", async () => {
    const rows = images(2);
    const provider = stubProvider(
      "Here are your descriptions:\n1. A dog.\n2. A cat.",
    );
    const batch = await describeMediaBatch(rows, { provider });

    expect(batch.results.size).toBe(0);
    expect(batch.call.status).toBe("error");
    expect(batch.call.error).toContain("echoed 0 of 2 ids");
  });

  it("an echoed UNREADABLE is a verdict on that file, and the rest of the batch still lands", async () => {
    const rows = images(2);
    const provider = stubProvider(
      `${BATCH_MARKER} #01\nA photo of ${rows[0].id}.\n\n${BATCH_MARKER} #02\nUNREADABLE`,
    );
    const batch = await describeMediaBatch(rows, { provider });

    expect(batch.results.get(rows[0].id)).toMatchObject({ status: "done" });
    expect(batch.results.get(rows[1].id)).toMatchObject({
      status: "skipped",
      description: null,
    });
  });

  it("a failed call is a retryable error against every image in it", async () => {
    const rows = images(3);
    const provider = stubProvider("", "error");
    const batch = await describeMediaBatch(rows, { provider });

    for (const r of rows) {
      expect(batch.results.get(r.id)).toMatchObject({
        status: "error",
        description: null,
        error: "boom",
      });
    }
    expect(batch.call.status).toBe("error");
  });

  it("a file that is gone is settled without being sent to the model", async () => {
    const rows = images(2);
    const missing = row({ id: "wa:alice@x/GONE", mediaPath: join(tmpDir, "gone.jpg") });
    const provider = stubProvider(batchAnswer(rows));
    const batch = await describeMediaBatch([...rows, missing], { provider });

    expect(batch.results.get(missing.id)?.status).toBe("skipped");
    expect(requestText(provider.calls[0])).not.toContain("gone.jpg");
  });

  it("a batch with nothing readable makes no call and logs none", async () => {
    const provider = stubProvider("a plausible-sounding invention");
    const batch = await describeMediaBatch(
      [row({ kind: "audio", mediaPath: file("VOICE.ogg") })],
      { provider },
    );
    expect(provider.calls).toHaveLength(0);
    expect(batch.call.status).toBe("skipped");
  });

  it("gives the run enough turns to open every file", async () => {
    const rows = images(6);
    const provider = stubProvider(batchAnswer(rows));
    await describeMediaBatch(rows, { provider });
    expect(provider.calls[0].maxAgentTurns).toBeGreaterThan(rows.length);
  });
});
