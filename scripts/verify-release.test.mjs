import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  REQUIRED_BUNDLE_FILES,
  assessDistribution,
  assertSynchronizedVersions,
  cargoPackageVersion,
  dmgMetadata,
  expectedArchitectures,
  expectedReleaseDigest,
  manifestDigest,
  missingBundleFiles,
  parseArgs,
} from "./verify-release.mjs";

describe("release artifact identity", () => {
  it("reads canonical Tauri and phase-prefixed archive names", () => {
    expect(dmgMetadata("SuperTwinV13_13.12.3_aarch64.dmg")).toEqual({
      version: "13.12.3",
      arch: "aarch64",
      canonical: true,
    });
    expect(dmgMetadata("SuperTwinV13_V6P1S6e_13.12.2.dmg")).toEqual({
      version: "13.12.2",
      arch: null,
      canonical: false,
    });
    expect(dmgMetadata("Other_13.12.3_aarch64.dmg")).toBeNull();
  });

  it("maps filename architectures to Mach-O names", () => {
    expect(expectedArchitectures("aarch64")).toEqual(["arm64"]);
    expect(expectedArchitectures("x64")).toEqual(["x86_64"]);
    expect(expectedArchitectures("universal")).toEqual(["arm64", "x86_64"]);
    expect(expectedArchitectures(null)).toEqual([]);
  });
});

describe("version and manifest parsing", () => {
  it("reads only the app package stanza from Cargo.lock", () => {
    const lock = `[[package]]\nname = "dependency"\nversion = "9.9.9"\n\n[[package]]\nname = "supertwinv13"\nversion = "13.12.3"\n`;
    expect(cargoPackageVersion(lock)).toBe("13.12.3");
    expect(cargoPackageVersion(lock, "missing")).toBeNull();
  });

  it("requires every source and lock version to agree", () => {
    const versions = {
      package: "13.12.3",
      worker: "13.12.3",
      tauri: "13.12.3",
      cargoToml: "13.12.3",
      cargoLock: "13.12.3",
      packageLock: "13.12.3",
    };
    expect(assertSynchronizedVersions(versions)).toBe("13.12.3");
    expect(() => assertSynchronizedVersions({ ...versions, cargoLock: "13.12.2" })).toThrow(
      /cargoLock=13\.12\.2/,
    );
  });

  it("accepts only a completed SHA row for the requested version", () => {
    const sha = "a".repeat(64);
    const manifest = `| Version | Size | SHA-256 |\n|---|---|---|\n| 13.12.2 | 992 MB | \`${sha}\` |\n| 13.12.3 | — | pending |\n`;
    expect(manifestDigest(manifest, "13.12.2")).toBe(sha);
    expect(manifestDigest(manifest, "13.12.3")).toBeNull();
  });

  it("accepts an explicit build digest for a pending row without weakening completed rows", () => {
    const oldSha = "a".repeat(64);
    const newSha = "b".repeat(64);
    const manifest = `| 13.12.2 | 992 MB | \`${oldSha}\` |\n| 13.12.3 | — | pending |\n`;
    expect(
      expectedReleaseDigest({ manifest, version: "13.12.3", expectedSha: newSha.toUpperCase() }),
    ).toBe(newSha);
    expect(() =>
      expectedReleaseDigest({ manifest, version: "13.12.2", expectedSha: newSha }),
    ).toThrow(/disagrees with RELEASES\.md/);
    expect(() => expectedReleaseDigest({ manifest, version: "13.12.3" })).toThrow(
      /pass --expected-sha/,
    );
  });
});

describe("self-contained bundle contract", () => {
  it("reports every missing runtime and model resource", () => {
    const root = mkdtempSync(join(tmpdir(), "st-verify-layout-"));
    try {
      for (const rel of REQUIRED_BUNDLE_FILES) {
        const path = join(root, rel);
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "fixture");
      }
      expect(missingBundleFiles(root)).toEqual([]);
      rmSync(join(root, REQUIRED_BUNDLE_FILES[0]));
      expect(missingBundleFiles(root)).toEqual([REQUIRED_BUNDLE_FILES[0]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("distribution truthfulness", () => {
  it("accepts a non-ad-hoc app only when Gatekeeper accepts it", () => {
    expect(assessDistribution({ spctlOk: true, signatureText: "Authority=Developer ID", allowAdhoc: false })).toEqual({
      ready: true,
      localOnly: false,
      message: "Gatekeeper accepted",
    });
  });

  it("refuses to call an ad-hoc app distributable", () => {
    expect(() =>
      assessDistribution({ spctlOk: false, signatureText: "Signature=adhoc\nTeamIdentifier=not set", allowAdhoc: false }),
    ).toThrow(/local-only/);
    expect(
      assessDistribution({ spctlOk: false, signatureText: "Signature=adhoc", allowAdhoc: true }),
    ).toMatchObject({ ready: false, localOnly: true });
  });
});

describe("CLI guardrails", () => {
  it("parses an explicit local-only waiver and DMG path", () => {
    const sha = "A".repeat(64);
    expect(
      parseArgs(["--allow-adhoc", "--dmg", "/tmp/app.dmg", "--expected-sha", sha]),
    ).toEqual({
      allowAdhoc: true,
      dmg: "/tmp/app.dmg",
      expectedSha: sha.toLowerCase(),
    });
    expect(() => parseArgs(["--dmg"])).toThrow(/requires a path/);
    expect(() => parseArgs(["--dmg", "--allow-adhoc"])).toThrow(/requires a path/);
    expect(() => parseArgs(["--expected-sha", "abc"])).toThrow(/64 hexadecimal/);
    expect(() => parseArgs(["--wat"])).toThrow(/unknown argument/);
  });
});
