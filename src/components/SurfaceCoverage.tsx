// [CODE] The coverage meter, wired to the worker — arch §14.0, "on every
// surface". Item 1.8 built the meter as a pure component; this is the one
// place that feeds it, so all eight surfaces poll the same endpoint on the same
// cadence and cannot drift into showing different progress for one run.
//
// A failed poll renders nothing rather than an error: the meter is chrome, and
// a broken meter must never take a surface down with it. The surface's own
// data errors are the surface's to report.

import { useEffect, useState } from "react";

import { CoverageMeter } from "./CoverageMeter";
import type { CoverageClient, CoverageSnapshot } from "../lib/surfaces-client";

/** Slow on purpose — the meter is monotonic, so a late poll costs nothing. */
export const COVERAGE_POLL_MS = 5000;

export interface SurfaceCoverageProps {
  /** Any surface's client: the meter only ever calls `getCoverage`. */
  client: CoverageClient;
  /** 0 disables polling (tests, and any surface that mounts briefly). */
  pollMs?: number;
}

export function SurfaceCoverage({ client, pollMs = COVERAGE_POLL_MS }: SurfaceCoverageProps) {
  const [snapshot, setSnapshot] = useState<CoverageSnapshot | null>(null);

  useEffect(() => {
    let live = true;
    const controller = new AbortController();

    const poll = async () => {
      try {
        const next = await client.getCoverage(controller.signal);
        if (live) setSnapshot(next);
      } catch {
        // Chrome stays quiet. See the header comment.
      }
    };

    void poll();
    const timer = pollMs > 0 ? setInterval(() => void poll(), pollMs) : undefined;
    return () => {
      live = false;
      controller.abort();
      if (timer !== undefined) clearInterval(timer);
    };
  }, [client, pollMs]);

  if (!snapshot) return null;

  return (
    <CoverageMeter
      rows={snapshot.rows}
      mode={snapshot.mode}
      pausedLabel={snapshot.pausedLabel ?? undefined}
      remainingMinutes={snapshot.remainingMinutes}
    />
  );
}
