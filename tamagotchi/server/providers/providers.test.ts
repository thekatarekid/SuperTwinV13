import { describe, expect, it } from "vitest";
import { DEFAULT_SELECTION } from "../../shared/options.ts";
import { selectProvider } from "../config.ts";
import { geminiProvider } from "./gemini.ts";
import { pollinationsProvider } from "./pollinations.ts";
import { ProviderError } from "./types.ts";

// Every test here uses a fake fetch: ZERO network calls, ZERO spend.

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const input = () => ({
  photo: PNG,
  photoMime: "image/png",
  prompt: "make a hero",
  selection: DEFAULT_SELECTION,
  signal: new AbortController().signal,
});

function fakeFetch(respond: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond(String(url), init ?? {});
  }) as typeof fetch;
  return { f, calls };
}

describe("selectProvider", () => {
  it("falls back to free demo mode with no keys", () => {
    expect(selectProvider({}).id).toBe("mock");
  });
  it("prefers Pollinations, then Gemini, and honours IMAGE_PROVIDER", () => {
    expect(selectProvider({ POLLINATIONS_API_KEY: "sk_x", GEMINI_API_KEY: "g" }).id).toBe("pollinations");
    expect(selectProvider({ GEMINI_API_KEY: "g" }).id).toBe("gemini");
    expect(selectProvider({ IMAGE_PROVIDER: "gemini", POLLINATIONS_API_KEY: "sk_x", GEMINI_API_KEY: "g" }).id).toBe("gemini");
    expect(selectProvider({ IMAGE_PROVIDER: "mock", POLLINATIONS_API_KEY: "sk_x" }).id).toBe("mock");
    expect(() => selectProvider({ IMAGE_PROVIDER: "gemini" })).toThrow(/GEMINI_API_KEY/);
    expect(() => selectProvider({ IMAGE_PROVIDER: "dalle" })).toThrow(/Unknown/);
  });
  it("lets the model be overridden", () => {
    expect(selectProvider({ POLLINATIONS_API_KEY: "sk_x", POLLINATIONS_MODEL: "bytedance/seedream-4.5" }).model).toBe("bytedance/seedream-4.5");
  });
});

describe("pollinations provider", () => {
  it("uploads the photo as multipart with the secret key and decodes b64 output", async () => {
    const { f, calls } = fakeFetch(() => Response.json({ created: 1, data: [{ b64_json: PNG.toString("base64") }], usage: {} }));
    const out = await pollinationsProvider("sk_test", undefined, f).generate(input());
    expect(out.mime).toBe("image/png");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://gen.pollinations.ai/v1/images/edits");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer sk_test");
    const form = calls[0].init.body as FormData;
    expect(form.get("model")).toBe("google/gemini-3.1-flash-image");
    expect(form.get("prompt")).toBe("make a hero");
    expect(form.get("response_format")).toBe("b64_json");
    expect((form.get("image") as File).type).toBe("image/png");
  });

  it("explains an empty balance", async () => {
    const { f } = fakeFetch(() => new Response(JSON.stringify({ error: "no pollen" }), { status: 402 }));
    const err = await pollinationsProvider("sk_test", undefined, f).generate(input()).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(402);
    expect(err.message).toMatch(/Quest Pollen/);
  });

  it("rejects a response without an image", async () => {
    const { f } = fakeFetch(() => Response.json({ created: 1, data: [{}], usage: {} }));
    await expect(pollinationsProvider("sk_test", undefined, f).generate(input())).rejects.toThrow(/no image/);
  });
});

describe("gemini provider", () => {
  it("sends the photo inline and reads inlineData back", async () => {
    const { f, calls } = fakeFetch(() =>
      Response.json({ candidates: [{ content: { parts: [{ text: "here" }, { inlineData: { mimeType: "image/png", data: PNG.toString("base64") } }] } }] }),
    );
    const out = await geminiProvider("g-key", undefined, f).generate(input());
    expect(out.mime).toBe("image/png");
    expect(calls[0].url).toContain("/models/gemini-3.1-flash-image-preview:generateContent");
    expect((calls[0].init.headers as Record<string, string>)["x-goog-api-key"]).toBe("g-key");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.contents[0].parts[0].inline_data.mime_type).toBe("image/png");
    expect(body.generationConfig.responseModalities).toEqual(["IMAGE"]);
  });

  it("reports a safety block", async () => {
    const { f } = fakeFetch(() => Response.json({ promptFeedback: { blockReason: "SAFETY" } }));
    await expect(geminiProvider("g", undefined, f).generate(input())).rejects.toThrow(/blocked/);
  });
});

describe("local MFLUX provider", () => {
  it("runs FLUX.2 Klein edit with the photo and cleans up the temp files", async () => {
    const { mfluxProvider } = await import("./mflux.ts");
    const { existsSync, writeFileSync } = await import("node:fs");
    let seen: string[] = [];
    const provider = mfluxProvider({
      run: async (bin, args) => {
        seen = [bin, ...args];
        const input = args[args.indexOf("--image-paths") + 1];
        expect(existsSync(input)).toBe(true);
        writeFileSync(args[args.indexOf("--output") + 1], PNG);
        return { code: 0, log: "" };
      },
    });
    expect(provider.billable).toBe(false);
    expect(provider.maxConcurrent).toBe(1);
    const out = await provider.generate(input());
    expect(out.mime).toBe("image/png");
    expect(seen[0]).toBe("mflux-generate-flux2-edit");
    expect(seen).toEqual(expect.arrayContaining(["--model", "flux2-klein-4b", "--steps", "4", "--quantize", "8", "--width", "1024"]));
    expect(existsSync(seen[seen.indexOf("--image-paths") + 1])).toBe(false); // photo deleted
  });

  it("explains a missing install and out-of-memory failures", async () => {
    const { mfluxProvider } = await import("./mflux.ts");
    const missing = mfluxProvider({
      run: async () => {
        throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
      },
    });
    await expect(missing.generate(input())).rejects.toThrow(/setup:local/);
    const oom = mfluxProvider({ run: async () => ({ code: 1, log: "[METAL] Insufficient Memory" }) });
    await expect(oom.generate(input())).rejects.toThrow(/out of memory/);
  });

  it("is auto-selected when installed and no key forces otherwise", () => {
    expect(selectProvider({}, () => true).id).toBe("local");
    expect(selectProvider({ IMAGE_PROVIDER: "pollinations", POLLINATIONS_API_KEY: "sk" }, () => true).id).toBe("pollinations");
    expect(selectProvider({ IMAGE_PROVIDER: "local", MFLUX_QUANTIZE: "4" }, () => false).label).toMatch(/free/);
  });
});
