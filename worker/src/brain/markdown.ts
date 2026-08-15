// ===========================================================================
// Markdown primitives for the brain wiki: slugify, YAML frontmatter
// parse/serialize (flat string map — all the brain needs), and machine-managed
// section merging.
//
// User-edit safety (the load-bearing invariant): writers never clobber a file.
// Machine-owned content lives between HTML comment markers
//
//   <!-- st:begin:<name> --> ... <!-- st:end:<name> -->
//
// and rewrites only replace the text INSIDE marker pairs. Anything the user
// typed outside the markers (or a whole section they added) survives every
// rewrite verbatim. Frontmatter is merged key-wise: machine keys win, but
// user-added keys are preserved.
// ===========================================================================

export type Frontmatter = Record<string, string>;

export interface ManagedSection {
  /** Marker name (stable across rewrites), e.g. "goals". */
  name: string;
  /** Markdown content of the section (without the markers). */
  content: string;
}

/** Filesystem/wiki-safe slug: lowercase ascii, dashes, trimmed, bounded. */
export function slugify(input: string): string {
  const s = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return s.length ? s : "untitled";
}

// ---- Frontmatter -----------------------------------------------------------

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Parse a leading `---` YAML block of flat `key: value` string pairs. */
export function parseFrontmatter(content: string): {
  data: Frontmatter;
  body: string;
} {
  const m = FM_RE.exec(content);
  if (!m) return { data: {}, body: content };
  const data: Frontmatter = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (!key || key.startsWith("#")) continue;
    let value = line.slice(idx + 1).trim();
    // Unquote simple quoted scalars.
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }
  return { data, body: content.slice(m[0].length) };
}

/** Serialize flat `key: value` pairs to a `---` block (quotes when needed). */
export function serializeFrontmatter(data: Frontmatter): string {
  const lines = Object.entries(data).map(([k, v]) => {
    const needsQuote = /[:#'"\n]|^\s|\s$/.test(v) || v.length === 0;
    return `${k}: ${needsQuote ? JSON.stringify(v) : v}`;
  });
  return `---\n${lines.join("\n")}\n---\n`;
}

// ---- Machine-managed sections ----------------------------------------------

export function beginMarker(name: string): string {
  return `<!-- st:begin:${name} -->`;
}

export function endMarker(name: string): string {
  return `<!-- st:end:${name} -->`;
}

/** Render a managed section (markers + content). */
export function renderSection(section: ManagedSection): string {
  return `${beginMarker(section.name)}\n${section.content.trim()}\n${endMarker(section.name)}`;
}

/**
 * Merge managed sections into an existing markdown body (frontmatter already
 * stripped). For each section: if the body contains its marker pair, only the
 * text between the markers is replaced; otherwise the section is appended.
 * Everything else — user prose, user-added sections — is preserved verbatim.
 */
export function mergeManagedSections(
  existingBody: string | null,
  sections: ManagedSection[],
): string {
  if (existingBody == null || existingBody.trim().length === 0) {
    return sections.map(renderSection).join("\n\n") + "\n";
  }

  let body = existingBody;
  const toAppend: ManagedSection[] = [];

  for (const section of sections) {
    const begin = beginMarker(section.name);
    const end = endMarker(section.name);
    const bi = body.indexOf(begin);
    const ei = bi >= 0 ? body.indexOf(end, bi + begin.length) : -1;
    if (bi >= 0 && ei >= 0) {
      body =
        body.slice(0, bi) + renderSection(section) + body.slice(ei + end.length);
    } else {
      toAppend.push(section);
    }
  }

  if (toAppend.length) {
    const sep = body.endsWith("\n\n") ? "" : body.endsWith("\n") ? "\n" : "\n\n";
    body += sep + toAppend.map(renderSection).join("\n\n") + "\n";
  }
  return body;
}

/**
 * Full-file upsert: merge frontmatter (machine keys win, user keys survive)
 * and managed sections into the existing content (or build a fresh document).
 */
export function upsertMarkdown(
  existing: string | null,
  frontmatter: Frontmatter,
  sections: ManagedSection[],
): string {
  const parsed = existing != null ? parseFrontmatter(existing) : { data: {}, body: null };
  const mergedFm = { ...parsed.data, ...frontmatter };
  const body = mergeManagedSections(parsed.body, sections);
  return serializeFrontmatter(mergedFm) + "\n" + body.replace(/^\n+/, "");
}

/** ISO-8601 UTC ms timestamp (matches the DB's strftime default format). */
export function nowIso(): string {
  return new Date().toISOString();
}
