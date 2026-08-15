// ===========================================================================
// Typed writers/readers for the brain wiki (Phase 2 contract).
//
// Every writer:
//   - calls ensureBrain() (seed + git init on first use),
//   - merges instead of clobbering: machine content lives inside
//     `<!-- st:begin:<name> --> ... <!-- st:end:<name> -->` markers and only
//     the inside of markers is rewritten — user edits outside survive,
//   - writes `[[wikilinks]]` for relationships and `evt:<id>` source links,
//   - returns the path (relative to the brain root) it wrote.
//
// Commits are the caller's job (batch related writes, then commitBrain(msg)).
// ===========================================================================

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  mergeManagedSections,
  nowIso,
  slugify,
  upsertMarkdown,
  type Frontmatter,
  type ManagedSection,
} from "./markdown.js";
import { ensureBrain } from "./root.js";

// ---- Input shapes -----------------------------------------------------------

export interface SpaceInput {
  /** Stable wiki slug; derived from name when omitted. */
  slug?: string;
  name: string;
  type?: string; // 'recurring' | 'one_time' | 'long_running'
  status?: string; // 'active' | 'archived'
  confidence?: string; // e.g. 'high' | 'medium' | 'low'
  latestUpdate?: { text: string; ts?: string } | null;
  state?: string | null;
  openQuestions?: string[];
}

export interface GoalInput {
  title: string;
  recurring?: boolean;
  milestones?: { title: string; status?: string }[];
}

export interface TaskInput {
  title: string;
  origin: "explicit" | "implicit";
  status?: string; // 'open' | 'done' | 'dismissed'
  sourceEventIds?: string[];
}

export interface PersonInput {
  slug?: string;
  name: string;
  relationship?: string | null;
  /** Space slugs this person shares with the user (rendered as wikilinks). */
  sharedSpaceSlugs?: string[];
  commitments?: { text: string; eventId?: string | null }[];
  lastInteraction?: { ts: string; summary?: string } | null;
  confidence?: string;
}

export interface PatternInput {
  slug?: string;
  kind: "habit" | "workflow";
  title: string;
  status: "candidate" | "confirmed" | "dismissed";
  /** Habit cadence ("every Sunday") or workflow trigger. */
  cadence?: string | null;
  /** Workflow steps (rendered as an ordered list). */
  steps?: string[];
  evidenceEventIds?: string[];
  notes?: string | null;
}

// ---- Shared helpers ---------------------------------------------------------

function evtLinks(ids: string[] | undefined): string {
  if (!ids || !ids.length) return "";
  return " " + ids.map((id) => `evt:${id}`).join(" ");
}

function readIfExists(abs: string): string | null {
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}

function writeMerged(
  root: string,
  relPath: string,
  frontmatter: Frontmatter,
  sections: ManagedSection[],
): string {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, upsertMarkdown(readIfExists(abs), frontmatter, sections), "utf8");
  return relPath;
}

/** Read a brain file by root-relative path (null when absent). */
export function readBrainFile(relPath: string): string | null {
  return readIfExists(join(ensureBrain(), relPath));
}

// ---- Spaces -----------------------------------------------------------------

/**
 * Upsert spaces/<slug>/space.md: frontmatter (type/status/confidence/
 * updated_at) + managed header/goals/tasks/latest-update/state/people
 * sections. Returns the root-relative path.
 */
export function upsertSpaceFile(
  space: SpaceInput,
  goals: GoalInput[],
  tasks: TaskInput[],
  people: PersonInput[],
): string {
  const root = ensureBrain();
  const slug = space.slug ?? slugify(space.name);

  const frontmatter: Frontmatter = {
    type: space.type ?? "one_time",
    status: space.status ?? "active",
    confidence: space.confidence ?? "medium",
    updated_at: nowIso(),
  };

  const goalLines = goals.length
    ? goals
        .map((g) => {
          const head = `- ${g.title}${g.recurring ? " (recurring)" : ""}`;
          const ms = (g.milestones ?? []).map(
            (m) => `  - [${m.status === "done" ? "x" : " "}] ${m.title}`,
          );
          return [head, ...ms].join("\n");
        })
        .join("\n")
    : "_No goals yet._";

  const taskLines = tasks.length
    ? tasks
        .map(
          (t) =>
            `- [${t.status === "done" ? "x" : " "}] ${t.title} (${t.origin})${evtLinks(t.sourceEventIds)}`,
        )
        .join("\n")
    : "_No tasks yet._";

  const latest = space.latestUpdate
    ? `${space.latestUpdate.ts ?? nowIso()} — ${space.latestUpdate.text}`
    : "_No updates yet._";

  const stateLines = [space.state ?? "_Unknown._"];
  if (space.openQuestions?.length) {
    stateLines.push("", "Open questions:");
    for (const q of space.openQuestions) stateLines.push(`- ${q}`);
  }

  const peopleLines = people.length
    ? people
        .map((p) => `- [[people/${p.slug ?? slugify(p.name)}]] (${p.name})`)
        .join("\n")
    : "_No people linked._";

  const sections: ManagedSection[] = [
    { name: "header", content: `# ${space.name}` },
    { name: "goals", content: `## Goals\n\n${goalLines}` },
    { name: "tasks", content: `## Tasks\n\n${taskLines}` },
    { name: "latest-update", content: `## Latest update\n\n${latest}` },
    { name: "state", content: `## State\n\n${stateLines.join("\n")}` },
    { name: "people", content: `## People\n\n${peopleLines}` },
  ];

  return writeMerged(root, join("spaces", slug, "space.md"), frontmatter, sections);
}

/** Append a timestamped entry to spaces/<slug>/log.md (created on demand). */
export function appendSpaceLog(slug: string, entry: string): string {
  const root = ensureBrain();
  const rel = join("spaces", slug, "log.md");
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  if (!existsSync(abs)) {
    writeFileSync(abs, `# Log — [[spaces/${slug}]]\n\n`, "utf8");
  }
  appendFileSync(abs, `- ${nowIso()} — ${entry.trim()}\n`, "utf8");
  return rel;
}

// ---- People (CRM) -----------------------------------------------------------

/**
 * Upsert people/<slug>.md with the CRM sections: relationship, shared spaces
 * (wikilinks), commitments (with evt links), last interaction.
 */
export function upsertPersonFile(person: PersonInput): string {
  const root = ensureBrain();
  const slug = person.slug ?? slugify(person.name);

  const frontmatter: Frontmatter = {
    type: "person",
    status: "active",
    confidence: person.confidence ?? "medium",
    updated_at: nowIso(),
  };

  const shared = person.sharedSpaceSlugs?.length
    ? person.sharedSpaceSlugs.map((s) => `- [[spaces/${s}]]`).join("\n")
    : "_None yet._";

  const commitments = person.commitments?.length
    ? person.commitments
        .map((c) => `- ${c.text}${c.eventId ? ` evt:${c.eventId}` : ""}`)
        .join("\n")
    : "_None tracked._";

  const last = person.lastInteraction
    ? `${person.lastInteraction.ts}${person.lastInteraction.summary ? ` — ${person.lastInteraction.summary}` : ""}`
    : "_Unknown._";

  const sections: ManagedSection[] = [
    { name: "header", content: `# ${person.name}` },
    {
      name: "relationship",
      content: `## Relationship\n\n${person.relationship ?? "_Unknown._"}`,
    },
    { name: "shared-spaces", content: `## Shared spaces\n\n${shared}` },
    { name: "commitments", content: `## Commitments\n\n${commitments}` },
    { name: "last-interaction", content: `## Last interaction\n\n${last}` },
  ];

  return writeMerged(root, join("people", `${slug}.md`), frontmatter, sections);
}

// ---- Patterns (habits / workflows) -------------------------------------------

/**
 * Upsert habits/<slug>.md or workflows/<slug>.md with `status:
 * candidate|confirmed|dismissed` frontmatter and evidence evt links.
 */
export function upsertPatternFile(pattern: PatternInput): string {
  const root = ensureBrain();
  const slug = pattern.slug ?? slugify(pattern.title);
  const dir = pattern.kind === "habit" ? "habits" : "workflows";

  const frontmatter: Frontmatter = {
    type: pattern.kind,
    status: pattern.status,
    evidence_count: String(pattern.evidenceEventIds?.length ?? 0),
    updated_at: nowIso(),
  };

  const bodyLines: string[] = [];
  if (pattern.cadence) {
    bodyLines.push(
      `**${pattern.kind === "habit" ? "Cadence" : "Trigger"}**: ${pattern.cadence}`,
    );
  }
  if (pattern.steps?.length) {
    bodyLines.push("", "## Steps", "");
    pattern.steps.forEach((s, i) => bodyLines.push(`${i + 1}. ${s}`));
  }
  if (pattern.notes) bodyLines.push("", pattern.notes);
  if (!bodyLines.length) bodyLines.push("_No details yet._");

  const evidence = pattern.evidenceEventIds?.length
    ? pattern.evidenceEventIds.map((id) => `- evt:${id}`).join("\n")
    : "_No observations yet._";

  const sections: ManagedSection[] = [
    { name: "header", content: `# ${pattern.title}` },
    { name: "body", content: bodyLines.join("\n") },
    { name: "evidence", content: `## Evidence\n\n${evidence}` },
  ];

  return writeMerged(root, join(dir, `${slug}.md`), frontmatter, sections);
}

// ---- Preferences --------------------------------------------------------------

/**
 * Append one preference bullet inside the managed `preferences` section of
 * me/preferences.md (with an optional evt source link). Existing bullets and
 * user prose are preserved.
 */
export function appendPreference(text: string, eventId?: string | null): string {
  const root = ensureBrain();
  const rel = join("me", "preferences.md");
  const abs = join(root, rel);

  const bullet = `- ${text.trim()}${eventId ? ` evt:${eventId}` : ""}`;
  const existing = readIfExists(abs);

  if (existing == null) {
    writeFileSync(
      abs,
      `---\ntype: preferences\nstatus: active\n---\n\n# Preferences\n\n` +
        mergeManagedSections(null, [{ name: "preferences", content: bullet }]),
      "utf8",
    );
    return rel;
  }

  // Grow the managed section: re-render it with the new bullet appended.
  const begin = "<!-- st:begin:preferences -->";
  const end = "<!-- st:end:preferences -->";
  const bi = existing.indexOf(begin);
  const ei = bi >= 0 ? existing.indexOf(end, bi + begin.length) : -1;
  let next: string;
  if (bi >= 0 && ei >= 0) {
    const inner = existing.slice(bi + begin.length, ei).trim();
    const content = inner.length ? `${inner}\n${bullet}` : bullet;
    next =
      existing.slice(0, bi) +
      `${begin}\n${content}\n${end}` +
      existing.slice(ei + end.length);
  } else {
    const sep = existing.endsWith("\n") ? "\n" : "\n\n";
    next = existing + sep + `${begin}\n${bullet}\n${end}\n`;
  }
  writeFileSync(abs, next, "utf8");
  return rel;
}

// ---- Journal (append-only nightly self-update log) ----------------------------

/**
 * Append a dated entry to me/journal.md. APPEND-ONLY and defensive: creates the
 * file with valid frontmatter when missing, and otherwise only appends a new
 * `## <date>\n<entry>\n` block — it NEVER rewrites prior content, so nightly
 * self-updates can't clobber earlier journal history. Returns the relative path.
 */
export function appendJournal(entry: string): string {
  const root = ensureBrain();
  const rel = join("me", "journal.md");
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  if (!existsSync(abs)) {
    writeFileSync(
      abs,
      "---\ntype: journal\nstatus: active\n---\n\n# Journal\n",
      "utf8",
    );
  }
  const date = nowIso().slice(0, 10); // YYYY-MM-DD
  appendFileSync(abs, `\n## ${date}\n${entry.trim()}\n`, "utf8");
  return rel;
}

// ---- Corrections (teach-the-extractor lessons) --------------------------------

/**
 * Append one lesson bullet inside the managed `corrections` section of
 * me/procedures/system-corrections.md (with an optional evt source link). A
 * rejected task writes a lesson here so the extractor's few-shot picks it up and
 * stops re-proposing the same thing (contract §11). Mirrors appendPreference:
 * only the inside of the markers is rewritten, so user prose survives.
 */
export function appendCorrection(text: string, eventId?: string | null): string {
  const root = ensureBrain();
  const rel = join("me", "procedures", "system-corrections.md");
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });

  const bullet = `- ${text.trim()}${eventId ? ` evt:${eventId}` : ""}`;
  const existing = readIfExists(abs);

  if (existing == null) {
    writeFileSync(
      abs,
      `---\ntype: corrections\nstatus: active\n---\n\n# System corrections\n\n` +
        mergeManagedSections(null, [{ name: "corrections", content: bullet }]),
      "utf8",
    );
    return rel;
  }

  const begin = "<!-- st:begin:corrections -->";
  const end = "<!-- st:end:corrections -->";
  const bi = existing.indexOf(begin);
  const ei = bi >= 0 ? existing.indexOf(end, bi + begin.length) : -1;
  let next: string;
  if (bi >= 0 && ei >= 0) {
    const inner = existing.slice(bi + begin.length, ei).trim();
    const content = inner.length ? `${inner}\n${bullet}` : bullet;
    next =
      existing.slice(0, bi) +
      `${begin}\n${content}\n${end}` +
      existing.slice(ei + end.length);
  } else {
    const sep = existing.endsWith("\n") ? "\n" : "\n\n";
    next = existing + sep + `${begin}\n${bullet}\n${end}\n`;
  }
  writeFileSync(abs, next, "utf8");
  return rel;
}
