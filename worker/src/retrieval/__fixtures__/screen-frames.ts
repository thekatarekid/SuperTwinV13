// Test fixture (V6 S2.3 / RET-06): a Safari window open on a villa listing.
// The window's TEXT (the diff) never says "villa" — only the title does.

import type { SnapshotFrame } from "../../adapters/screen/frames.js";

export function villaFrame(over: Partial<SnapshotFrame> = {}): SnapshotFrame {
  return {
    t: "snapshot",
    ts: "2026-09-01T10:15:00.000Z",
    bundle_id: "com.apple.Safari",
    app_name: "Safari",
    window_title: "Villas in Goa – Airbnb",
    doc_key: "airbnb.com/s/Goa/homes",
    stream_key: "com.apple.Safari¦airbnb.com/s/Goa/homes",
    trigger: "tab_switch",
    tree_hash: "t1",
    content_hash: "c1",
    char_count: 44,
    new_chars: "6 beds · swimming pool · ₹18,000 / night",
    text: "6 beds · swimming pool · ₹18,000 / night",
    links: [],
    files: [],
    ...over,
  };
}
