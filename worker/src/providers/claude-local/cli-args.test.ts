// ===========================================================================
// Unit tests for the pure CLI-arg / child-env builders. These assert the
// plain-completion flag combination that stops the extraction runaway
// (bounded, tool-free, single-turn, neutral-settings JSON completion) WITHOUT
// spawning the real `claude` binary.
// ===========================================================================

import { describe, it, expect } from "vitest";

import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCliArgs,
  buildChildEnv,
  PLAIN_COMPLETION_MAX_TURNS,
  PROMPT_CACHE_TTL,
  safeCwd,
  THINKING_BUDGET_TOKENS,
} from "./index.js";
import {
  isValidModelId,
  isValidRole,
  MODEL_CATALOG,
  MODEL_ROLES,
  DEFAULT_MODEL_ID,
} from "./models.js";

/** Read the single value that follows `flag` in an argv array. */
function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * Run `fn` with `process.env` patched, then restore exactly. A patch value of
 * `undefined` DELETES the variable for the duration of the call.
 *
 * buildChildEnv() starts from `{ ...process.env }` — inheriting the parent
 * environment is the whole point of it — so any assertion about what the
 * function itself contributes has to control the ambient value first.
 * Otherwise the test is really asserting on the shell that launched vitest
 * (CI sandboxes that export MAX_THINKING_TOKENS made this fail).
 */
function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(patch)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("buildCliArgs — plain completion mode", () => {
  it("forces --max-turns 2, tool denial, and neutral settings", () => {
    const args = buildCliArgs({ allowedTools: [], plainCompletion: true });

    // Two turns, forced regardless of caller: one answer plus one preamble
    // allowance (FIX-C2). One was a turn too few — a model that opens with
    // "I'll process this bundle of 92 events" spent the only turn it had and
    // the CLI ended the run before the JSON, which the ladder then paid for
    // all over again at full context.
    expect(argValue(args, "--max-turns")).toBe(String(PLAIN_COMPLETION_MAX_TURNS));
    expect(PLAIN_COMPLETION_MAX_TURNS).toBe(2);

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

  it("owns its turn budget even if the caller passes a larger maxTurns", () => {
    const args = buildCliArgs({
      allowedTools: [],
      plainCompletion: true,
      maxTurns: 25,
    });
    expect(argValue(args, "--max-turns")).toBe("2");
  });

  it("still streams (partial messages / stream-json) for token accounting", () => {
    const args = buildCliArgs({ allowedTools: [], plainCompletion: true });
    expect(args).toContain("--print");
    expect(args).toContain("--include-partial-messages");
    expect(argValue(args, "--output-format")).toBe("stream-json");
  });
});

// ---------------------------------------------------------------------------
// The bare-call contract (arch §4.1). Every EXTRACTION call is a bare
// instrument: no user settings, no tools, one turn, no thinking, tmpdir.
// ---------------------------------------------------------------------------
describe("buildCliArgs — the bare-call contract", () => {
  const ALL_THIRTEEN = [
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
    "TodoWrite",
    "BashOutput",
    "KillShell",
  ];

  it("denies all THIRTEEN built-in tools, not just the famous ones", () => {
    const args = buildCliArgs({ allowedTools: [], plainCompletion: true });
    const disallowed = (argValue(args, "--disallowedTools") ?? "").split(",");
    expect(disallowed).toEqual(ALL_THIRTEEN);
  });

  it("grants nothing even when the caller passes a tool whitelist", () => {
    // A leaked whitelist is how a bare extraction call turns agentic.
    const args = buildCliArgs({
      allowedTools: ["Read", "Bash"],
      plainCompletion: true,
    });
    expect(argValue(args, "--allowedTools")).toBe("");
  });

  it("never emits a --system-prompt flag — the CLI has no such flag", () => {
    const args = buildCliArgs({
      allowedTools: [],
      plainCompletion: true,
      appendSystemPrompt: "INSTRUCTIONS",
    });
    expect(args).not.toContain("--system-prompt");
    expect(argValue(args, "--append-system-prompt")).toBe("INSTRUCTIONS");
  });

  it("carries every lever together — one missing lever is the runaway", () => {
    const args = buildCliArgs({ allowedTools: [], plainCompletion: true });
    expect(argValue(args, "--setting-sources")).toBe("");
    expect(argValue(args, "--allowedTools")).toBe("");
    expect(argValue(args, "--max-turns")).toBe("2");
    expect(args).toContain("--disallowedTools");
    withEnv({ MAX_THINKING_TOKENS: undefined }, () => {
      expect(buildChildEnv("claude", true).MAX_THINKING_TOKENS).toBe("0");
    });
  });
});

describe("thinkingBudget ladder (§4.3)", () => {
  it("maps the six rungs to the documented token counts", () => {
    expect(THINKING_BUDGET_TOKENS).toEqual({
      off: 0,
      low: 2048,
      medium: 8192,
      high: 24576,
      xhigh: 49152,
      max: 65536,
    });
  });

  it("puts the chosen rung on the child env", () => {
    withEnv({ MAX_THINKING_TOKENS: undefined }, () => {
      expect(buildChildEnv("claude", false, undefined, "off").MAX_THINKING_TOKENS).toBe("0");
      expect(buildChildEnv("claude", false, undefined, "low").MAX_THINKING_TOKENS).toBe("2048");
      expect(buildChildEnv("claude", false, undefined, "medium").MAX_THINKING_TOKENS).toBe("8192");
      expect(buildChildEnv("claude", false, undefined, "high").MAX_THINKING_TOKENS).toBe("24576");
      expect(buildChildEnv("claude", false, undefined, "xhigh").MAX_THINKING_TOKENS).toBe("49152");
      expect(buildChildEnv("claude", false, undefined, "max").MAX_THINKING_TOKENS).toBe("65536");
    });
  });

  it("an explicit budget wins over an inherited value in either mode", () => {
    withEnv({ MAX_THINKING_TOKENS: "31999" }, () => {
      expect(buildChildEnv("claude", false, undefined, "off").MAX_THINKING_TOKENS).toBe("0");
      expect(buildChildEnv("claude", true, undefined, "high").MAX_THINKING_TOKENS).toBe("24576");
    });
  });
});

describe("safeCwd — never a TCC-protected directory (§4.1.4)", () => {
  it("falls back to tmpdir for ~/Documents, ~/Desktop and ~/Downloads", () => {
    withEnv({ HOME: "/Users/someone" }, () => {
      expect(safeCwd("/Users/someone/Documents")).toBe(tmpdir());
      expect(safeCwd("/Users/someone/Documents/repo/worker")).toBe(tmpdir());
      expect(safeCwd("/Users/someone/Desktop")).toBe(tmpdir());
      expect(safeCwd("/Users/someone/Downloads/x")).toBe(tmpdir());
    });
  });

  it("defaults to tmpdir when no cwd is given", () => {
    expect(safeCwd()).toBe(tmpdir());
    expect(safeCwd("")).toBe(tmpdir());
    expect(safeCwd(null)).toBe(tmpdir());
  });

  it("keeps an ordinary directory, and is not fooled by a prefix match", () => {
    withEnv({ HOME: "/Users/someone" }, () => {
      const ok = join(tmpdir(), "st-run");
      expect(safeCwd(ok)).toBe(ok);
      // "DocumentsArchive" is NOT inside "Documents".
      expect(safeCwd("/Users/someone/DocumentsArchive")).toBe(
        "/Users/someone/DocumentsArchive",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// TRANSPORT STAGE 1+2 (build S0.4; backlog T1-1/T1-2; SPD-04/SPD-05).
// The argv is snapshotted verbatim: a flag that goes missing, or a copy of the
// prompt that sneaks back on, fails the diff rather than a sampled assertion.
// Every flag below was verified against `claude --help` (2.1.251).
// ---------------------------------------------------------------------------
describe("buildCliArgs — transport stage 1+2 (S0.4) argv snapshot", () => {
  it("a bare pass: one door, every flag, instruction block once", () => {
    const args = buildCliArgs({
      allowedTools: ["Read"], // must not survive
      plainCompletion: true,
      appendSystemPrompt: "INSTRUCTIONS",
      model: "haiku",
      maxBudgetUsd: 0.5,
    });
    expect(args).toMatchInlineSnapshot(`
      [
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--safe-mode",
        "--strict-mcp-config",
        "--allowedTools",
        "",
        "--disallowedTools",
        "Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,Task,NotebookEdit,TodoWrite,BashOutput,KillShell",
        "--setting-sources",
        "",
        "--model",
        "haiku",
        "--max-budget-usd",
        "0.5",
        "--no-session-persistence",
        "--append-system-prompt",
        "INSTRUCTIONS",
        "--max-turns",
        "2",
      ]
    `);
    // SPD-04 wrong: `double-prompt` — the block appears exactly once on argv.
    expect(args.filter((a) => a === "INSTRUCTIONS")).toHaveLength(1);
  });

  it("a fresh chat turn: same door, but the session is kept for --resume", () => {
    const args = buildCliArgs({
      allowedTools: [],
      skipUserSettings: true,
      appendSystemPrompt: "CHAT PROMPT",
      maxBudgetUsd: 0.5,
    });
    expect(args).toMatchInlineSnapshot(`
      [
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--safe-mode",
        "--strict-mcp-config",
        "--allowedTools",
        "",
        "--setting-sources",
        "",
        "--max-budget-usd",
        "0.5",
        "--append-system-prompt",
        "CHAT PROMPT",
      ]
    `);
  });

  it("stage 2 flags are on EVERY invocation, plain or not, resume or not", () => {
    for (const args of [
      buildCliArgs({ allowedTools: [] }),
      buildCliArgs({ allowedTools: ["Read"], maxTurns: 4 }),
      buildCliArgs({ allowedTools: [], plainCompletion: true }),
      buildCliArgs({ allowedTools: [], resumeId: "0f1e2d3c-4b5a-4978-8877-665544332211" }),
    ]) {
      expect(args).toContain("--safe-mode");
      expect(args).toContain("--strict-mcp-config");
      expect(args.filter((a) => a === "--safe-mode")).toHaveLength(1);
    }
  });

  it("--no-session-persistence follows plainCompletion by default and persistSession when set", () => {
    expect(buildCliArgs({ allowedTools: [], plainCompletion: true })).toContain(
      "--no-session-persistence",
    );
    expect(buildCliArgs({ allowedTools: [] })).not.toContain("--no-session-persistence");
    // An explicit answer wins in both directions.
    expect(
      buildCliArgs({ allowedTools: [], plainCompletion: true, persistSession: true }),
    ).not.toContain("--no-session-persistence");
    expect(buildCliArgs({ allowedTools: [], persistSession: false })).toContain(
      "--no-session-persistence",
    );
  });

  it("never combines --no-session-persistence with --resume", () => {
    const args = buildCliArgs({
      allowedTools: [],
      persistSession: false,
      resumeId: "0f1e2d3c-4b5a-4978-8877-665544332211",
    });
    expect(args).not.toContain("--no-session-persistence");
    expect(argValue(args, "--resume")).toBe("0f1e2d3c-4b5a-4978-8877-665544332211");
  });

  it("passes --max-budget-usd only for a finite positive amount", () => {
    expect(argValue(buildCliArgs({ allowedTools: [], maxBudgetUsd: 0.25 }), "--max-budget-usd")).toBe("0.25");
    expect(buildCliArgs({ allowedTools: [] })).not.toContain("--max-budget-usd");
    expect(buildCliArgs({ allowedTools: [], maxBudgetUsd: 0 })).not.toContain("--max-budget-usd");
    expect(buildCliArgs({ allowedTools: [], maxBudgetUsd: Number.NaN })).not.toContain("--max-budget-usd");
    expect(buildCliArgs({ allowedTools: [], maxBudgetUsd: -1 })).not.toContain("--max-budget-usd");
  });

  it("the prompt never goes on argv in any mode", () => {
    for (const args of [
      buildCliArgs({ allowedTools: [], plainCompletion: true, appendSystemPrompt: "SYS" }),
      buildCliArgs({ allowedTools: [], appendSystemPrompt: "SYS" }),
    ]) {
      // The ONLY prompt-ish bytes allowed on argv are the system block, once.
      expect(args.filter((a) => a === "SYS")).toHaveLength(1);
      expect(args).not.toContain("--system-prompt");
    }
  });
});

describe("buildChildEnv — prompt cache TTL (S0.4, SPD-05)", () => {
  it("pins CLAUDE_CODE_PROMPT_CACHE_TTL=5m in every mode", () => {
    expect(PROMPT_CACHE_TTL).toBe("5m");
    withEnv({ CLAUDE_CODE_PROMPT_CACHE_TTL: undefined }, () => {
      expect(buildChildEnv("claude", true).CLAUDE_CODE_PROMPT_CACHE_TTL).toBe("5m");
      expect(buildChildEnv("claude", false).CLAUDE_CODE_PROMPT_CACHE_TTL).toBe("5m");
    });
  });

  it("overrides an inherited 1-hour setting — that is the 2.0x surcharge", () => {
    withEnv({ CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" }, () => {
      expect(buildChildEnv("claude", false, "/tmp/x", "off").CLAUDE_CODE_PROMPT_CACHE_TTL).toBe("5m");
    });
  });
});

describe("MODEL_ROLES — one picker per step (§4.2)", () => {
  it("carries every role this build calls", () => {
    expect(MODEL_ROLES.map((r) => r.key)).toEqual([
      "chat",
      "media",
      "entity",
      "episode",
      "arc",
      "extract",
      "triage",
      "done_detect",
      "classify",
      "adjudicate",
    ]);
  });

  it("validates its own keys and rejects unknown ones", () => {
    for (const r of MODEL_ROLES) expect(isValidRole(r.key)).toBe(true);
    expect(isValidRole("execution")).toBe(false);
    expect(isValidRole("")).toBe(false);
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
    expect(argValue(args, "--max-turns")).toBe("2");
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
    // With nothing ambient, plain completion pins the budget to 0 and normal
    // mode contributes nothing of its own.
    withEnv({ MAX_THINKING_TOKENS: undefined }, () => {
      expect(buildChildEnv("claude", true).MAX_THINKING_TOKENS).toBe("0");
      expect(buildChildEnv("claude", false).MAX_THINKING_TOKENS).toBeUndefined();
    });
  });

  it("overrides an inherited budget in plain completion but inherits it otherwise", () => {
    withEnv({ MAX_THINKING_TOKENS: "31999" }, () => {
      expect(buildChildEnv("claude", true).MAX_THINKING_TOKENS).toBe("0");
      expect(buildChildEnv("claude", false).MAX_THINKING_TOKENS).toBe("31999");
    });
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
