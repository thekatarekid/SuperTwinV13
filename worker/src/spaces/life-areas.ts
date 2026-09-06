// ===========================================================================
// Life areas (Product_V6 §11.10.1) — the grouping the Spaces list uses.
//
// The fourteen defaults, editable later; a space whose life_area is null or
// unknown lists under "Other" so nothing disappears from the list.
// ===========================================================================

export const LIFE_AREAS = [
  "Work",
  "Health",
  "Money",
  "Admin",
  "People",
  "Home",
  "Travel",
  "Shopping",
  "Content",
  "Learning",
  "Hobbies",
  "Events",
  "Community",
  "Safety",
] as const;

export type LifeArea = (typeof LIFE_AREAS)[number];

export const OTHER_AREA = "Other";

/** Canonical casing for a stored life_area, or "Other" for null/unknown. */
export function normalizeLifeArea(area: string | null | undefined): string {
  if (!area) return OTHER_AREA;
  const hit = LIFE_AREAS.find((a) => a.toLowerCase() === area.trim().toLowerCase());
  return hit ?? OTHER_AREA;
}

/** Stable order: the fourteen defaults in spec order, then "Other". */
export function lifeAreaRank(area: string): number {
  const i = (LIFE_AREAS as readonly string[]).indexOf(area);
  return i === -1 ? LIFE_AREAS.length : i;
}
