// Settings stub — build P1.7 (Library graduated to its own screen in P2.4;
// Timeline graduated in P4.1). The Settings subtabs land with P4.3.
// Settings carries the version footer (build plan §1.8): the worker's
// /api/health version + BUILT_THROUGH_PHASE, e.g. "v13.1.1 · built through P1".

import { useEffect, useState } from "react";
import { fetchHealth } from "../lib/api";

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
