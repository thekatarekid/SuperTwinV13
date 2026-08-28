// CDP client — request/response correlation, event fan-out, close semantics.
import { describe, expect, it } from "vitest";
import { CdpClient, CdpError } from "./cdp.js";
import { FakeCdpTransport } from "./fake-cdp.js";

describe("CdpClient", () => {
  it("correlates responses to their commands by id", async () => {
    const t = new FakeCdpTransport((method) => ({ echoed: method }));
    const c = new CdpClient(t);
    const [a, b] = await Promise.all([c.send("A"), c.send("B")]);
    expect(a).toEqual({ echoed: "A" });
    expect(b).toEqual({ echoed: "B" });
  });

  it("surfaces CDP errors as CdpError", async () => {
    const t = new FakeCdpTransport(() => {
      throw new Error("boom");
    });
    const c = new CdpClient(t);
    await expect(c.send("X")).rejects.toBeInstanceOf(CdpError);
  });

  it("fans events out to subscribers and waitFor resolves on match", async () => {
    const t = new FakeCdpTransport(() => ({}));
    const c = new CdpClient(t);
    const seen: string[] = [];
    c.on("Ev", (ev) => seen.push(String(ev.params.n)));
    const waited = c.waitFor("Ev", (ev) => ev.params.n === 2);
    t.emit("Ev", { n: 1 });
    t.emit("Ev", { n: 2 });
    const ev = await waited;
    expect(ev.params.n).toBe(2);
    expect(seen).toEqual(["1", "2"]);
  });

  it("rejects in-flight commands when the connection closes", async () => {
    const t = new FakeCdpTransport(() => ({}));
    const c = new CdpClient(t);
    const never = c.send("Never"); // responder queues a microtask; close first
    c.close();
    await expect(never).rejects.toThrow(/closed/);
    expect(c.isClosed).toBe(true);
    await expect(c.send("After")).rejects.toThrow(/closed/);
  });
});
