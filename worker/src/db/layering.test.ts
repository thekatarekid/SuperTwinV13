// ===========================================================================
// [TEST] The db layer stays a leaf (Stage 4 gate).
//
// WHY THIS FILE EXISTS. S4.7 wired the injection detector into the single
// ingest funnel, db/eventlog.ts, and the detector writes its card through
// assist/artifacts.ts — which at the time imported brain/critic, brain/llm
// and prompts/critic.v4 at module scope. That closed a ring:
//
//   db/settings -> db/ingest -> db/eventlog -> safety/injection ->
//   assist/artifacts -> brain/critic -> brain/orient -> packer/index ->
//   packer/spaces -> retrieval/embedder -> media/tools -> db/settings
//
// media/tools.ts builds WHISPER_MODELS from DEFAULT_WHISPER_MODEL at module
// scope, so entering the ring at db/settings evaluated that entry while the
// constant was still in its temporal dead zone: real ESM threw, and the
// vitest/esbuild CJS transforms silently produced `{ id: undefined }` — the
// bundled whisper model, unfindable. One test caught it by luck.
//
// The invariant that actually prevents the whole family: nothing under db/
// may reach brain/, packer/ or retrieval/ through module-scope imports. The
// db layer is what those layers are built ON. A pass that needs the model
// stack from inside a db-adjacent module loads it lazily (`await import()`)
// the way assist/artifacts.ts#graduateArtifact does.
//
// Type-only imports are invisible at runtime and do not count.
// ===========================================================================

import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every non-test module under src/. */
function modules(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) modules(path, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

/** Runtime edges only: value imports, side-effect imports, re-exports. */
const EDGE_PATTERNS = [
  /import\s+(?!type\s)[^;]*?from\s+["'](\.[^"']+)["']/g,
  /import\s+["'](\.[^"']+)["']/g,
  /export\s+(?!type\s)[^;]*?from\s+["'](\.[^"']+)["']/g,
];

function importGraph(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const file of modules(SRC)) {
    const source = readFileSync(file, "utf8");
    const deps = new Set<string>();
    for (const pattern of EDGE_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source))) {
        let target = resolve(dirname(file), match[1].replace(/\.js$/, ".ts"));
        if (!existsSync(target) && existsSync(target.replace(/\.ts$/, "/index.ts"))) {
          target = target.replace(/\.ts$/, "/index.ts");
        }
        if (existsSync(target)) deps.add(target);
      }
    }
    graph.set(file, [...deps]);
  }
  return graph;
}

/** The first module-scope path from `from` into any of `forbidden`, or null. */
function pathIntoLayers(
  graph: Map<string, string[]>,
  from: string,
  forbidden: readonly string[],
): string[] | null {
  const seen = new Set([from]);
  const queue: string[][] = [[from]];
  while (queue.length) {
    const path = queue.shift()!;
    for (const dep of graph.get(path[path.length - 1]) ?? []) {
      const rel = relative(SRC, dep);
      if (forbidden.some((layer) => rel.startsWith(layer))) return [...path, dep];
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push([...path, dep]);
      }
    }
  }
  return null;
}

describe("module layering", () => {
  const graph = importGraph();
  const dbModules = [...graph.keys()].filter((f) => relative(SRC, f).startsWith("db/"));

  it("nothing under db/ reaches brain/, packer/ or retrieval/ at module scope", () => {
    const offenders: string[] = [];
    for (const file of dbModules) {
      const path = pathIntoLayers(graph, file, ["brain/", "packer/", "retrieval/"]);
      if (path) offenders.push(path.map((p) => relative(SRC, p)).join(" -> "));
    }
    expect(offenders).toEqual([]);
  });

  it("the ingest funnel does not drag the model stack in behind the injection detector", () => {
    // The specific edge that broke: db/eventlog -> safety/injection -> ... -> brain.
    const injection = join(SRC, "safety/injection.ts");
    expect(existsSync(injection)).toBe(true);
    const path = pathIntoLayers(graph, injection, ["brain/", "packer/", "retrieval/"]);
    expect(path?.map((p) => relative(SRC, p)).join(" -> ")).toBeUndefined();
  });

  it("db/settings cannot reach media/tools, whose catalogue reads it at module scope", () => {
    // The TDZ that made WHISPER_MODELS grow an entry with no id.
    const settings = join(SRC, "db/settings.ts");
    const path = pathIntoLayers(graph, settings, ["media/tools.ts"]);
    expect(path?.map((p) => relative(SRC, p)).join(" -> ")).toBeUndefined();
  });

  it("sanity: the graph is real — a known edge is present", () => {
    const eventlog = graph.get(join(SRC, "db/eventlog.ts")) ?? [];
    expect(eventlog.map((p) => relative(SRC, p))).toContain("safety/injection.ts");
  });
});
