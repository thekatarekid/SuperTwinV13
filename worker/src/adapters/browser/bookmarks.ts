// ===========================================================================
// Bookmarks (build P0.8; spec §4.2 source 3 "Bookmarks file watched").
//
// Chrome + Arc: a plain JSON file (`Bookmarks`) next to the History DB.
// Safari: `~/Library/Safari/Bookmarks.plist` is a BINARY plist — parsing it
// dependency-free is out of P0.8's budget, so Safari bookmarks are skipped
// gracefully (visits still flow; documented deviation).
//
// The watcher polls mtime + re-parses; diffing against the previously seen
// URL set makes the emit idempotent across restarts is NOT needed here — the
// event `content_hash` (url + date_added) dedupes at the append layer.
// ===========================================================================

import { readFileSync } from "node:fs";

import { chromeTimeToUnixMs } from "./history-db.js";

export interface RawBookmark {
  url: string;
  title: string;
  folder: string;
  addedMs: number;
}

interface ChromeBookmarkNode {
  type?: string;
  url?: string;
  name?: string;
  date_added?: string;
  children?: ChromeBookmarkNode[];
}

/** Parse a Chromium `Bookmarks` JSON file into a flat list. */
export function parseChromiumBookmarks(jsonText: string): RawBookmark[] {
  const out: RawBookmark[] = [];
  let doc: { roots?: Record<string, ChromeBookmarkNode> };
  try {
    doc = JSON.parse(jsonText) as { roots?: Record<string, ChromeBookmarkNode> };
  } catch {
    return out;
  }
  const walk = (node: ChromeBookmarkNode, folder: string): void => {
    if (node.type === "url" && typeof node.url === "string") {
      const addedUs = Number(node.date_added ?? "0");
      out.push({
        url: node.url,
        title: node.name ?? "",
        folder,
        addedMs: Number.isFinite(addedUs) && addedUs > 0 ? chromeTimeToUnixMs(addedUs) : 0,
      });
      return;
    }
    for (const child of node.children ?? []) {
      walk(child, node.name ? (folder ? `${folder}/${node.name}` : node.name) : folder);
    }
  };
  for (const root of Object.values(doc.roots ?? {})) {
    if (root && typeof root === "object") walk(root, "");
  }
  return out;
}

/** Read + parse a Chromium bookmarks file; [] on any error (guard gracefully). */
export function readChromiumBookmarks(path: string): RawBookmark[] {
  try {
    return parseChromiumBookmarks(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}
