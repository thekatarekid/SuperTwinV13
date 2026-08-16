// [CODE] Archetype presentation — arch §14.6, build item 3.10.
//
// §14.6 is "one card layout, eight archetypes differentiated by icon + accent
// + signal strip". Icon and accent are presentation and live here. The STRIP
// TEXT does not: `₹1,499 due 28 Aug · unpaid` needs a ledger, `next Sat ·
// streak 6` needs an occurrence history, and a browser that composed either
// would be inventing them. The worker sends `signalStrip`; this file's job is
// only to make sure a missing one reads as missing.

import { ARCHETYPE_ICON, ARCHETYPE_NAMES, type Archetype, type SpaceView } from "../../lib/spaces-client";

export interface ArchetypeChrome {
  icon: string;
  name: string;
  /** The CSS accent modifier — `space--prj`. One class, eight values. */
  modifier: string;
}

/** An unclassified space is still a space; it renders as "unclassified". */
export function archetypeChrome(archetype: Archetype | null): ArchetypeChrome {
  if (!archetype) return { icon: "○", name: "unclassified", modifier: "space--none" };
  return {
    icon: ARCHETYPE_ICON[archetype],
    name: ARCHETYPE_NAMES[archetype],
    modifier: `space--${archetype}`,
  };
}

/**
 * The signal strip, or an honest placeholder. Never a composed one: see the
 * header for why the browser is not allowed to guess at this line.
 */
export function signalStrip(space: SpaceView): string {
  return space.signalStrip ?? "no signal recorded yet";
}

/** §14.6's markers: 💤 dormant, 🗄 archived, ◍ still growing, 📌 pinned. */
export function stateMarkers(space: SpaceView): string[] {
  const marks: string[] = [];
  if (space.pinned) marks.push("📌 pinned");
  if (space.status === "dormant") marks.push(`💤 ${space.dormantNote ?? "dormant"}`);
  if (space.status === "archived") marks.push("🗄 archived");
  if (space.stillGrowing) marks.push("◍ still growing");
  return marks;
}

/**
 * Context claims, preferences weighted first (§14.6). Weighted rows lead;
 * within each band the worker's order is kept, because relevance is its
 * computation and re-sorting on confidence here would silently override it.
 */
export function orderedContext<T extends { weighted: boolean }>(claims: readonly T[]): T[] {
  return [...claims.filter((c) => c.weighted), ...claims.filter((c) => !c.weighted)];
}
