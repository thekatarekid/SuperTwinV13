// ===========================================================================
// Brain wiki module tests: root seeding + git init idempotency, typed writers
// (markdown shape, wikilinks, evt links), the user-edit-safety merge invariant
// (content outside st:begin/st:end markers survives rewrites), and the
// traversal-guarded GET /api/brain/file route.
//
// Each test points SUPERTWIN_BRAIN_DIR at a fresh temp dir.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendPreference,
  appendSpaceLog,
  brainRoot,
  commitBrain,
  ensureBrain,
  handleBrainRoute,
  mergeManagedSections,
  parseFrontmatter,
  readBrainFile,
  resetBrainCacheForTests,
  serializeFrontmatter,
  slugify,
  upsertPatternFile,
  upsertPersonFile,
  upsertSpaceFile,
} from "./index.js";

const gitAvailable = (() => {
  try {
    return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-brain-test-"));
  process.env.SUPERTWIN_BRAIN_DIR = join(tmpDir, "brain");
  resetBrainCacheForTests();
});

afterEach(() => {
  delete process.env.SUPERTWIN_BRAIN_DIR;
  resetBrainCacheForTests();
  rmSync(tmpDir, { recursive: true, force: true });
});

function read(rel: string): string {
  return readFileSync(join(brainRoot(), rel), "utf8");
}

// ---- markdown primitives ----------------------------------------------------

describe("markdown primitives", () => {
  it("slugify produces filesystem/wiki-safe slugs", () => {
    expect(slugify("Goa Trip 2026!")).toBe("goa-trip-2026");
    expect(slugify("  Café — déjà vu  ")).toBe("cafe-deja-vu");
    expect(slugify("///")).toBe("untitled");
  });

  it("frontmatter round-trips flat key/value pairs", () => {
    const fm = { type: "space", status: "active", updated_at: "2026-07-02T00:00:00.000Z" };
    const parsed = parseFrontmatter(serializeFrontmatter(fm) + "\nbody text\n");
    expect(parsed.data).toEqual(fm);
    expect(parsed.body.trim()).toBe("body text");
  });

  it("mergeManagedSections replaces only inside markers", () => {
    const v1 = mergeManagedSections(null, [{ name: "goals", content: "## Goals\n\n- a" }]);
    const edited = `user intro line\n\n${v1}\nuser outro line\n`;
    const v2 = mergeManagedSections(edited, [{ name: "goals", content: "## Goals\n\n- b" }]);
    expect(v2).toContain("user intro line");
    expect(v2).toContain("user outro line");
    expect(v2).toContain("- b");
    expect(v2).not.toContain("- a");
  });
});

// ---- root: seeding + git ------------------------------------------------------

describe("brain root", () => {
  it("brainRoot honors SUPERTWIN_BRAIN_DIR", () => {
    expect(brainRoot()).toBe(join(tmpDir, "brain"));
  });

  it("ensureBrain seeds the canonical layout (spaces/people/workflows/habits/me)", () => {
    const root = ensureBrain();
    for (const dir of ["spaces", "people", "workflows", "habits", "me", join("me", "procedures")]) {
      expect(existsSync(join(root, dir)), `missing ${dir}`).toBe(true);
    }
    expect(existsSync(join(root, "me", "preferences.md"))).toBe(true);
    expect(existsSync(join(root, "me", "goals.md"))).toBe(true);
  });

  it("git init is idempotent and commitBrain never throws", () => {
    const root = ensureBrain();
    resetBrainCacheForTests();
    expect(() => ensureBrain()).not.toThrow(); // second seed pass is a no-op
    if (gitAvailable) {
      expect(existsSync(join(root, ".git"))).toBe(true);
      writeFileSync(join(root, "people", "x.md"), "# X\n", "utf8");
      expect(commitBrain("test commit")).toBe(true);
      // Nothing new to commit -> false, but no throw.
      expect(commitBrain("empty commit")).toBe(false);
    } else {
      expect(() => commitBrain("no git")).not.toThrow();
    }
  });
});

// ---- writers ------------------------------------------------------------------

describe("space writer", () => {
  const space = {
    name: "Goa Trip",
    type: "one_time",
    status: "active",
    confidence: "high",
    latestUpdate: { text: "flights booked", ts: "2026-07-01T10:00:00.000Z" },
    state: "planning",
  };
  const goals = [
    { title: "Book travel", milestones: [{ title: "flights", status: "done" }, { title: "hotel" }] },
  ];
  const tasks = [
    { title: "Pay Rahul back", origin: "explicit" as const, status: "open", sourceEventIds: ["ev1", "ev2"] },
  ];
  const people = [{ name: "Rahul Mehta" }];

  it("produces frontmatter + managed sections with wikilinks and evt links", () => {
    const rel = upsertSpaceFile(space, goals, tasks, people);
    expect(rel).toBe(join("spaces", "goa-trip", "space.md"));

    const content = read(rel);
    const { data } = parseFrontmatter(content);
    expect(data.type).toBe("one_time");
    expect(data.status).toBe("active");
    expect(data.confidence).toBe("high");
    expect(data.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(content).toContain("# Goa Trip");
    expect(content).toContain("## Goals");
    expect(content).toContain("- Book travel");
    expect(content).toContain("  - [x] flights");
    expect(content).toContain("  - [ ] hotel");
    expect(content).toContain("- [ ] Pay Rahul back (explicit) evt:ev1 evt:ev2");
    expect(content).toContain("2026-07-01T10:00:00.000Z — flights booked");
    expect(content).toContain("[[people/rahul-mehta]]");
  });

  it("preserves user-added content outside markers on rewrite", () => {
    const rel = upsertSpaceFile(space, goals, tasks, people);
    const abs = join(brainRoot(), rel);

    // Simulate the user hand-editing the file: prose outside markers + a
    // custom section of their own.
    const edited =
      read(rel) +
      "\n## My scratch notes\n\nremember to renew passport\n";
    writeFileSync(abs, edited, "utf8");

    upsertSpaceFile(
      { ...space, latestUpdate: { text: "hotel booked", ts: "2026-07-02T09:00:00.000Z" } },
      goals,
      [...tasks, { title: "Buy sunscreen", origin: "implicit" as const, status: "open" }],
      people,
    );

    const after = read(rel);
    expect(after).toContain("## My scratch notes");
    expect(after).toContain("remember to renew passport");
    expect(after).toContain("hotel booked");
    expect(after).toContain("- [ ] Buy sunscreen (implicit)");
    expect(after).not.toContain("flights booked"); // managed section replaced
    // Marker pairs stay unique (no duplicated managed sections).
    expect(after.split("<!-- st:begin:tasks -->").length).toBe(2);
  });

  it("preserves user-added frontmatter keys while updating machine keys", () => {
    const rel = upsertSpaceFile(space, [], [], []);
    const abs = join(brainRoot(), rel);
    const { data, body } = parseFrontmatter(read(rel));
    writeFileSync(abs, serializeFrontmatter({ ...data, my_tag: "beach" }) + "\n" + body, "utf8");

    upsertSpaceFile({ ...space, confidence: "low" }, [], [], []);
    const after = parseFrontmatter(read(rel)).data;
    expect(after.my_tag).toBe("beach");
    expect(after.confidence).toBe("low");
  });

  it("appendSpaceLog creates and appends timestamped entries", () => {
    appendSpaceLog("goa-trip", "space created from 12 events");
    appendSpaceLog("goa-trip", "merged with beach-plan");
    const log = read(join("spaces", "goa-trip", "log.md"));
    expect(log).toContain("# Log — [[spaces/goa-trip]]");
    const entries = log.split("\n").filter((l) => l.startsWith("- "));
    expect(entries.length).toBe(2);
    expect(entries[1]).toContain("merged with beach-plan");
  });
});

describe("person / pattern / preference writers", () => {
  it("upsertPersonFile writes the CRM sections", () => {
    const rel = upsertPersonFile({
      name: "Rahul Mehta",
      relationship: "college friend",
      sharedSpaceSlugs: ["goa-trip"],
      commitments: [{ text: "send hotel options", eventId: "ev9" }],
      lastInteraction: { ts: "2026-06-30T20:00:00.000Z", summary: "planned dates" },
    });
    expect(rel).toBe(join("people", "rahul-mehta.md"));
    const content = read(rel);
    expect(parseFrontmatter(content).data.type).toBe("person");
    expect(content).toContain("## Relationship");
    expect(content).toContain("college friend");
    expect(content).toContain("[[spaces/goa-trip]]");
    expect(content).toContain("- send hotel options evt:ev9");
    expect(content).toContain("2026-06-30T20:00:00.000Z — planned dates");
  });

  it("upsertPatternFile routes habits vs workflows and carries candidate status", () => {
    const habit = upsertPatternFile({
      kind: "habit",
      title: "Sunday groceries",
      status: "candidate",
      cadence: "every Sunday",
      evidenceEventIds: ["e1", "e2", "e3"],
    });
    expect(habit).toBe(join("habits", "sunday-groceries.md"));
    const h = read(habit);
    const hd = parseFrontmatter(h).data;
    expect(hd.status).toBe("candidate");
    expect(hd.evidence_count).toBe("3");
    expect(h).toContain("**Cadence**: every Sunday");
    expect(h).toContain("- evt:e2");

    const wf = upsertPatternFile({
      kind: "workflow",
      title: "Monthly rent",
      status: "confirmed",
      steps: ["landlord pings", "transfer rent", "send receipt"],
    });
    expect(wf).toBe(join("workflows", "monthly-rent.md"));
    const w = read(wf);
    expect(parseFrontmatter(w).data.status).toBe("confirmed");
    expect(w).toContain("2. transfer rent");
  });

  it("appendPreference accumulates bullets and preserves surrounding prose", () => {
    const rel = appendPreference("prefers window seats", "ev5");
    appendPreference("no calls before 10am");
    const content = read(rel);
    expect(content).toContain("- prefers window seats evt:ev5");
    expect(content).toContain("- no calls before 10am");
    // The seeded explanatory prose outside the markers survives.
    expect(content).toContain("Feedback-derived rules");
  });

  it("readBrainFile returns content or null", () => {
    upsertPersonFile({ name: "Mom" });
    expect(readBrainFile(join("people", "mom.md"))).toContain("# Mom");
    expect(readBrainFile(join("people", "nobody.md"))).toBeNull();
  });
});

// ---- GET /api/brain/file (traversal-guarded) -----------------------------------

describe("GET /api/brain/file", () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    server = createServer((req, res) => {
      handleBrainRoute(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("returns { path, content } for a file inside the brain root", async () => {
    upsertSpaceFile({ name: "Goa Trip" }, [], [], []);
    const res = await fetch(
      `${base}/api/brain/file?path=${encodeURIComponent("spaces/goa-trip/space.md")}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; content: string };
    expect(body.path).toBe("spaces/goa-trip/space.md");
    expect(body.content).toContain("# Goa Trip");
  });

  it("400s on a missing path param", async () => {
    const res = await fetch(`${base}/api/brain/file`);
    expect(res.status).toBe(400);
  });

  it("403s on path traversal outside the brain root", async () => {
    ensureBrain();
    writeFileSync(join(tmpDir, "secret.txt"), "outside", "utf8");
    for (const evil of ["../secret.txt", "spaces/../../secret.txt", ".."]) {
      const res = await fetch(`${base}/api/brain/file?path=${encodeURIComponent(evil)}`);
      expect(res.status, `path=${evil}`).toBe(403);
    }
    // Encoded-slash variant must never leak the file either (it resolves to a
    // literal filename inside the root -> 404, not the outside file).
    const enc = await fetch(`${base}/api/brain/file?path=..%252Fsecret.txt`);
    expect(enc.status).not.toBe(200);
  });

  it("404s on a missing file and on a directory", async () => {
    ensureBrain();
    expect((await fetch(`${base}/api/brain/file?path=spaces/nope.md`)).status).toBe(404);
    expect((await fetch(`${base}/api/brain/file?path=spaces`)).status).toBe(404);
  });
});
