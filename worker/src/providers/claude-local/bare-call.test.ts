// ===========================================================================
// The bare-call contract, asserted against a real spawn (arch §4.1).
//
// buildCliArgs/buildChildEnv are unit-tested next door; this file checks that
// `send()` actually WIRES them — that an extraction call reaches the process
// boundary with no user settings, no tools, one turn, no thinking, a safe cwd,
// the prompt on stdin (never argv), and the instruction block passed TWICE.
//
// The fake CLI is a node script, deliberately not a shell script: a shell
// repairs PWD itself and would mask what the child was really handed.
// ===========================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stage = mkdtempSync(join(tmpdir(), "st-bare-call-"));
const fakeCli = join(stage, "fake-claude.cjs");
const probeOut = join(stage, "probe.json");
const promptFile = join(stage, "instructions.txt");

const INSTRUCTIONS = "STW-2 INSTRUCTION BLOCK: emit rows, nothing else.";
const PAYLOAD = "E|1|the episode body";

const savedEnv = new Map<string, string | undefined>();
function setEnv(key: string, value: string): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  process.env[key] = value;
}

interface Probe {
  argv: string[];
  stdin: string;
  cwd: string;
  thinking: string | null;
}

beforeAll(() => {
  writeFileSync(
    fakeCli,
    [
      "#!/usr/bin/env node",
      'const { writeFileSync } = require("node:fs");',
      'let stdin = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (c) => { stdin += c; });',
      'process.stdin.on("end", () => {',
      "  writeFileSync(process.env.ST_PROBE_OUT, JSON.stringify({",
      "    argv: process.argv.slice(2),",
      "    stdin,",
      "    cwd: process.cwd(),",
      "    thinking: process.env.MAX_THINKING_TOKENS ?? null,",
      "  }));",
      "  process.exit(0);",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(fakeCli, 0o755);
  writeFileSync(promptFile, INSTRUCTIONS, "utf8");

  // resolveClaudeBin() caches on first use, so this must be set before the
  // provider ever spawns — which, in this file, it is.
  setEnv("CLAUDE_BIN", fakeCli);
  setEnv("ST_PROBE_OUT", probeOut);
  setEnv("HOME", stage);
  setEnv("MAX_THINKING_TOKENS", "31999"); // an inherited budget that must not leak
});

afterAll(() => {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** One extraction-shaped send against the fake CLI. */
async function sendBare(
  extra: Record<string, unknown> = {},
): Promise<Probe> {
  const { claudeLocalProvider } = await import("./index.js");
  await claudeLocalProvider.send({
    runId: `bare-${Math.random().toString(36).slice(2)}`,
    message: PAYLOAD,
    plainCompletion: true,
    systemPromptFile: promptFile,
    allowedTools: ["Read"], // must NOT survive: a bare call grants nothing
    onEvent: () => {},
    ...extra,
  });
  return JSON.parse(readFileSync(probeOut, "utf8")) as Probe;
}

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

describe("send() — an extraction call is a bare instrument", () => {
  it("leaks no settings, no tools and no thinking", async () => {
    const probe = await sendBare();
    expect(argValue(probe.argv, "--setting-sources")).toBe("");
    expect(argValue(probe.argv, "--allowedTools")).toBe("");
    expect(argValue(probe.argv, "--max-turns")).toBe("1");
    expect((argValue(probe.argv, "--disallowedTools") ?? "").split(",")).toHaveLength(13);
    expect(probe.thinking).toBe("0");
  });

  it("passes the instruction block TWICE — flag and head of stdin", async () => {
    const probe = await sendBare();
    expect(argValue(probe.argv, "--append-system-prompt")).toBe(INSTRUCTIONS);
    expect(probe.stdin.startsWith(INSTRUCTIONS)).toBe(true);
    expect(probe.stdin).toContain(PAYLOAD);
    // ...and there is no --system-prompt flag to invent.
    expect(probe.argv).not.toContain("--system-prompt");
  });

  it("keeps the prompt off argv entirely", async () => {
    const probe = await sendBare();
    expect(probe.argv.some((a) => a.includes(PAYLOAD))).toBe(false);
  });

  it("runs in tmpdir, never in a TCC-protected directory", async () => {
    const probe = await sendBare({ cwd: join(stage, "Documents", "repo") });
    // /var is a symlink to /private/var on macOS: compare through realpath.
    expect(realpathSync(probe.cwd)).toBe(realpathSync(tmpdir()));
  });

  it("honours an explicit thinking rung when one is asked for", async () => {
    const probe = await sendBare({ thinkingBudget: "high" });
    expect(probe.thinking).toBe("24576");
  });

  it("can be told not to duplicate the block (chat keeps one copy)", async () => {
    const probe = await sendBare({ duplicateInstructions: false });
    expect(argValue(probe.argv, "--append-system-prompt")).toBe(INSTRUCTIONS);
    expect(probe.stdin).toBe(PAYLOAD);
  });
});
