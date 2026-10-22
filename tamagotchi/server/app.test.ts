import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SELECTION } from "../shared/options.ts";
import { createApp } from "./app.ts";
import { GenerationBudget } from "./budget.ts";
import { mockProvider } from "./providers/mock.ts";
import { ProviderError, type ImageProvider } from "./providers/types.ts";

// A 1×1 PNG — enough to pass the photo sniffing.
const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let server: Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function start(provider: ImageProvider, budget = new GenerationBudget(10, 10)) {
  const app = createApp({ provider, budget, timeoutMs: 2000 });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

const post = (base: string, body: unknown) =>
  fetch(`${base}/api/mascot`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function fakeProvider(impl: ImageProvider["generate"], billable = true): ImageProvider & { calls: number } {
  const p = {
    id: "pollinations" as const,
    label: "fake",
    model: "fake-model",
    billable,
    calls: 0,
    generate: async (input: Parameters<ImageProvider["generate"]>[0]) => {
      p.calls++;
      return impl(input);
    },
  };
  return p;
}

describe("server", () => {
  it("reports the provider (demo mode without keys)", async () => {
    const base = await start(mockProvider());
    const res = await fetch(`${base}/api/health`);
    expect(await res.json()).toMatchObject({ ok: true, provider: "mock", demo: true });
  });

  it("generates a mascot end-to-end with the mock provider", async () => {
    const base = await start(mockProvider());
    const res = await post(base, { photo: PNG_1PX, options: DEFAULT_SELECTION, name: "Captain <b>Kid" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.image).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(body.name).toBe("Captain bKid");
    expect(Buffer.from(body.image.split(",")[1], "base64").toString()).toContain("#d62839"); // crimson suit
  });

  it("passes the photo bytes and a built prompt to the provider", async () => {
    const provider = fakeProvider(async (input) => {
      expect(input.photoMime).toBe("image/png");
      expect(input.photo.length).toBeGreaterThan(50);
      expect(input.prompt).toMatch(/LIKENESS/);
      return { image: Buffer.from(PNG_1PX.split(",")[1], "base64"), mime: "image/png" };
    });
    const base = await start(provider);
    const res = await post(base, { photo: PNG_1PX, options: DEFAULT_SELECTION });
    expect(res.status).toBe(200);
    expect((await res.json()).image).toMatch(/^data:image\/png;base64,/);
    expect(provider.calls).toBe(1);
  });

  it("rejects bad input before calling the provider", async () => {
    const provider = fakeProvider(async () => ({ image: Buffer.alloc(0), mime: "image/png" }));
    const base = await start(provider);
    expect((await post(base, { photo: "data:image/gif;base64,R0lGOD", options: DEFAULT_SELECTION })).status).toBe(400);
    expect((await post(base, { photo: "data:image/png;base64,aGVsbG8=", options: DEFAULT_SELECTION })).status).toBe(400);
    expect((await post(base, { photo: PNG_1PX, options: { ...DEFAULT_SELECTION, style: ["x"] } })).status).toBe(400);
    const notJson = await fetch(`${base}/api/mascot`, { method: "POST", body: "hi" });
    expect(notJson.status).toBe(415);
    expect((await fetch(`${base}/api/mascot`)).status).toBe(405);
    expect(provider.calls).toBe(0);
  });

  it("stops billable generations at the budget ceiling", async () => {
    const provider = fakeProvider(async () => ({ image: Buffer.from(PNG_1PX.split(",")[1], "base64"), mime: "image/png" }));
    const base = await start(provider, new GenerationBudget(1, 5));
    expect((await post(base, { photo: PNG_1PX, options: DEFAULT_SELECTION })).status).toBe(200);
    const denied = await post(base, { photo: PNG_1PX, options: DEFAULT_SELECTION });
    expect(denied.status).toBe(429);
    expect((await denied.json()).error).toMatch(/Hourly limit/);
    expect(provider.calls).toBe(1);
  });

  it("surfaces provider errors with their message and status", async () => {
    const base = await start(fakeProvider(async () => Promise.reject(new ProviderError("Out of pollen", 402))));
    const res = await post(base, { photo: PNG_1PX, options: DEFAULT_SELECTION });
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("Out of pollen");
  });

  it("hides unexpected provider failures behind a friendly message", async () => {
    const base = await start(fakeProvider(async () => Promise.reject(new Error("socket hang up: secret internals"))));
    const res = await post(base, { photo: PNG_1PX, options: DEFAULT_SELECTION });
    expect(res.status).toBe(502);
    expect((await res.json()).error).not.toMatch(/secret/);
  });
});
