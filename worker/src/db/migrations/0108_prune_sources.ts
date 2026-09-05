// ===========================================================================
// 0108_prune_sources — V6 P1 S0.5 (Build §2.3, backlog T4-13).
//
// `sources.connected_at` and `sources.enabled` had zero readers and zero
// writers in the product path: columns that look like consent and mean
// nothing are worse than none. The real consent record lands in S1
// (migration 0200_v6_core). SQLite ≥ 3.35 drops a column in place; neither
// column is indexed, referenced by a view, or part of a constraint.
// ===========================================================================

/** The 0108_prune_sources migration body. */
export const PRUNE_SOURCES = `
ALTER TABLE sources DROP COLUMN connected_at;
ALTER TABLE sources DROP COLUMN enabled;
`;
