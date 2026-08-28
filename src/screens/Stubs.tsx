// Timeline / Library / Settings stubs — build P1.7. The pill nav needs the
// four tabs (spec §14.1.3); these screens fill out in P2.4 (Library),
// P4 (Timeline polish) and the Settings items land with their lanes.
// Settings carries the version footer (build plan §1.8): the worker's
// /api/health version + BUILT_THROUGH_PHASE, e.g. "v13.1.1 · built through P1".

import { useEffect, useState } from "react";
import { fetchHealth } from "../lib/api";

export function Timeline(): JSX.Element {
  return (
    <div className="stub">
      <h1>Timeline</h1>
      <p>The event log rendered — arrives with the capture lanes (spec §14.3).</p>
    </div>
  );
}

export function Library(): JSX.Element {
  return (
    <div className="stub">
      <h1>Library</h1>
      <p>Per-source capture + trust controls — arrives with P2.4 (spec §14.3.2).</p>
    </div>
  );
}

export function Settings(): JSX.Element {
  const [footer, setFooter] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchHealth()
      .then((h) => {
        if (alive) setFooter(`v${h.version} · built through ${h.builtThroughPhase}`);
      })
      .catch(() => {
        if (alive) setFooter(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="stub">
      <h1>Settings</h1>
      <p>General · Capture &amp; Privacy · Sources · Intelligence · Enrichment · Assist · Runs · Data (spec §14.9).</p>
      {footer && (
        <p className="version-footer" style={{ color: "var(--ink-2)", fontSize: "12px" }}>
          {footer}
        </p>
      )}
    </div>
  );
}
