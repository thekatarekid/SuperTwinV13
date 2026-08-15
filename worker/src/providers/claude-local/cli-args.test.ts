// ===========================================================================
// Unit tests for the pure CLI-arg / child-env builders. These assert the
// plain-completion flag combination that stops the extraction runaway
// (bounded, tool-free, single-turn, neutral-settings JSON completion) WITHOUT
// spawning the real `claude` binary.
// ===========================================================================

import { describe, it, expect } from "vitest";

import { buildCliArgs, buildChildEnv } from "./index.js";
import { isValidModelId, MODEL_CATALOG, DEFAULT_MODEL_ID } from "./models.js";

/** Read the single value that follows `flag` in an argv array. */
function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

describe("buildCliArgs — plain completion mode", () => {
  it("forces --max-turns 1, tool denial, and neutral settings", () => {
    const args = buildCliArgs({ allowedTools: [], plainCompletion: true });

    // Single turn (forced regardless of caller).
    expect(argValue(args, "--max-turns")).toBe("1");

    // Hard tool denial covers every built-in agentic tool.
    const disallowed = argValue(args, "--disallowedTools") ?? "";
    for (const tool of [
      "Bash",
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "WebSearch",
      "WebFetch",
      "Task",
      "NotebookEdit",
    ]) {
      expect(disallowed.split(",")).toContain(tool);
    }

    // Neutral settings: do NOT load the user's/project's CLAUDE.md, hooks, or
    // settings. `--setting-sources ""` (empty) disables all sources.
    expect(args).toContain("--setting-sources");
    expect(argValue(args, "--setting-sources")).toBe("");
  });

  it("forces one turn even if the caller passes a larger maxTurns", () => {
    const args = buildCliArgs({
      allowedTools: [],
      plainCompletion: true,
      maxTurns: 25,
    });
    expect(argValue(args, "--max-turns")).toBe("1");
  });

  it("still streams (partial messages / stream-json) for token accounting", () => {
    const args = buildCliArgs({ allowedTools: [], plainCompletion: true });
    expect(args).toContain("--print");
    expect(args).toContain("--include-partial-messages");
    expect(argValue(args, "--output-format")).toBe("stream-json");
  });
});

describe("buildCliArgs — skipUserSettings", () => {
  it("drops the user's settings without plain-completion's other restrictions", () => {
    const args = buildCliArgs({
      allowedTools: ["Read"],
      skipUserSettings: true,
      maxTurns: 4,
    });
    expect(argValue(args, "--setting-sources")).toBe("");
    // A media read still needs its tools and its turns.
    expect(args).not.toContain("--disallowedTools");
    expect(argValue(args, "--max-turns")).toBe("4");
    expect(argValue(args, "--allowedTools")).toBe("Read");
  });

  it("passes --setting-sources exactly once when combined with plainCompletion", () => {
    const args = buildCliArgs({
      allowedTools: [],
      plainCompletion: true,
      skipUserSettings: true,
    });
    expect(args.filter((a) => a === "--setting-sources")).toHaveLength(1);
  });

  it("is off by default", () => {
    expect(buildCliArgs({ allowedTools: ["Read"] })).not.toContain(
      "--setting-sources",
    );
  });
});

describe("buildCliArgs — normal (chat) mode is unchanged", () => {
  it("does NOT add tool denial or setting-sources, and honours maxTurns", () => {
    const args = buildCliArgs({ allowedTools: ["Read"], maxTurns: 8 });
    expect(args).not.toContain("--disallowedTools");
    expect(args).not.toContain("--setting-sources");
    expect(argValue(args, "--max-turns")).toBe("8");
    expect(argValue(args, "--allowedTools")).toBe("Read");
  });

  it("omits --max-turns entirely when the caller does not set it", () => {
    const args = buildCliArgs({ allowedTools: [] });
    expect(args).not.toContain("--max-turns");
  });
});

describe("buildCliArgs — model selection", () => {
  it("adds --model <id> when a model is set", () => {
    const args = buildCliArgs({
      allowedTools: [],
      model: "claude-opus-4-8",
    });
    expect(argValue(args, "--model")).toBe("claude-opus-4-8");
  });

  it("trims a padded model id before passing it", () => {
    const args = buildCliArgs({ allowedTools: [], model: "  opus  " });
    expect(argValue(args, "--model")).toBe("opus");
  });

  it("adds NO --model when model is the empty-string default", () => {
    const args = buildCliArgs({ allowedTools: [], model: "" });
    expect(args).not.toContain("--model");
  });

  it("adds NO --model when model is whitespace-only", () => {
    const args = buildCliArgs({ allowedTools: [], model: "   " });
    expect(args).not.toContain("--model");
  });

  it("adds NO --model when model is undefined", () => {
    const args = buildCliArgs({ allowedTools: [] });
    expect(args).not.toContain("--model");
  });

  it("threads model alongside plain-completion mode", () => {
    const args = buildCliArgs({
      allowedTools: [],
      plainCompletion: true,
      model: "haiku",
    });
    expect(argValue(args, "--model")).toBe("haiku");
    expect(argValue(args, "--max-turns")).toBe("1");
  });
});

describe("isValidModelId / catalog", () => {
  it("accepts the empty-string default and known aliases", () => {
    expect(isValidModelId("")).toBe(true);
    expect(isValidModelId("opus")).toBe(true);
    expect(isValidModelId("claude-opus-4-8")).toBe(true);
  });

  it("rejects unknown ids", () => {
    expect(isValidModelId("gpt-4")).toBe(false);
    expect(isValidModelId("claude-opus-9-9")).toBe(false);
  });

  it("keeps the empty default as the first catalog entry", () => {
    expect(DEFAULT_MODEL_ID).toBe("");
    expect(MODEL_CATALOG[0]).toEqual({
      id: "",
      label: "Default (subscription)",
      family: "Default",
    });
    // Every catalog id validates against isValidModelId (self-consistency).
    for (const m of MODEL_CATALOG) expect(isValidModelId(m.id)).toBe(true);
  });
});

describe("buildChildEnv — plain completion disables extended thinking", () => {
  it("sets MAX_THINKING_TOKENS=0 only in plain-completion mode", () => {
    const plain = buildChildEnv("claude", true);
    expect(plain.MAX_THINKING_TOKENS).toBe("0");

    const normal = buildChildEnv("claude", false);
    expect(normal.MAX_THINKING_TOKENS).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// REGRESSION: the child's PWD must name the directory it is spawned in.
//
// The worker inherits the .app's environment. Launched for development, that
// PWD is the repo — under ~/Documents, which macOS protects with TCC. Handing
// that PWD to a child spawned with cwd=tmpdir() made the CLI scan a directory
// it was not allowed to read and block in openat() until the provider timeout,
// producing no stdout, no stderr and no network traffic. Every chat turn timed
// out; the same argv run from a shell (which always keeps PWD == cwd) was fine.
// ---------------------------------------------------------------------------
describe("buildChildEnv — PWD agrees with the spawn cwd", () => {
  const withEnv = <T>(patch: Record<string, string>, fn: () => T): T => {
    const saved = new Map<string, string | undefined>();
    for (const [k, v] of Object.entries(patch)) {
      saved.set(k, process.env[k]);
      process.env[k] = v;
    }
    try {
      return fn();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it("overwrites an inherited PWD that points somewhere else", () => {
    const env = withEnv(
      { PWD: "/Users/someone/Documents/some-repo" },
      () => buildChildEnv("claude", false, "/tmp/st-sandbox"),
    );
    expect(env.PWD).toBe("/tmp/st-sandbox");
  });

  it("drops a stale OLDPWD rather than passing another wrong directory", () => {
    const env = withEnv(
      {
        PWD: "/Users/someone/Documents/some-repo",
        OLDPWD: "/Users/someone/Desktop",
      },
      () => buildChildEnv("claude", false, "/tmp/st-sandbox"),
    );
    expect(env.OLDPWD).toBeUndefined();
  });

  it("sets PWD for plain completion too (media reads spawn the same way)", () => {
    const env = withEnv({ PWD: "/Users/someone/Desktop" }, () =>
      buildChildEnv("/usr/local/bin/claude", true, "/var/media-root"),
    );
    expect(env.PWD).toBe("/var/media-root");
    expect(env.MAX_THINKING_TOKENS).toBe("0");
  });

  it("leaves the inherited PWD alone when no cwd is supplied", () => {
    const env = withEnv({ PWD: "/Users/someone/whatever" }, () =>
      buildChildEnv("claude", false),
    );
    expect(env.PWD).toBe("/Users/someone/whatever");
  });
});
