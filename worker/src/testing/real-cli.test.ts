import { describe, expect, it } from "vitest";
import { probeRealCli } from "./real-cli.js";

// The whole point of probeRealCli is that it distinguishes "no binary" from
// "broken binary". If that distinction ever collapses, the real-CLI suites
// would skip themselves on a genuine regression and the build would go green
// while proving nothing — so it is asserted rather than assumed.

const enoent = () => {
  const e = new Error("spawnSync claude ENOENT") as NodeJS.ErrnoException;
  e.code = "ENOENT";
  throw e;
};

const eacces = () => {
  const e = new Error("spawnSync claude EACCES") as NodeJS.ErrnoException;
  e.code = "EACCES";
  throw e;
};

describe("probeRealCli", () => {
  it("reports available with the trimmed version when the CLI runs", () => {
    const probe = probeRealCli((() => "1.2.3\n") as never);
    expect(probe).toEqual({ available: true, version: "1.2.3" });
  });

  it("reports unavailable when the binary is not on PATH", () => {
    const probe = probeRealCli(enoent as never);
    expect(probe.available).toBe(false);
    expect(probe.available === false && probe.reason).toContain("ENOENT");
  });

  it("reports unavailable when the binary cannot be executed", () => {
    const probe = probeRealCli(eacces as never);
    expect(probe.available).toBe(false);
  });

  it("RETHROWS when the CLI exists but misbehaves — a broken CLI is not a missing one", () => {
    const nonZeroExit = () => {
      const e = new Error("Command failed: claude --version") as NodeJS.ErrnoException;
      e.code = "1"; // execFileSync surfaces the exit status here, not an errno
      throw e;
    };
    expect(() => probeRealCli(nonZeroExit as never)).toThrow(/Command failed/);
  });

  it("rethrows an errno-less failure rather than treating it as absence", () => {
    expect(() =>
      probeRealCli((() => {
        throw new Error("something else entirely");
      }) as never),
    ).toThrow(/something else entirely/);
  });
});
