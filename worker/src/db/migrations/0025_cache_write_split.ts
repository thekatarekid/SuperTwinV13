// ===========================================================================
// 0025_cache_write_split — the cache-write half, broken down by TTL.
//
// A cache write bills at 1.25x a fresh input token at the 5-minute TTL and at
// 2.0x at the 1-hour TTL, and this build's CLI writes 1-HOUR entries: the wire
// fixture in providers/claude-local/parser.test.ts carries
// `ephemeral_1h_input_tokens: 10472` against `ephemeral_5m` at 0, and a
// least-squares fit of the stored real runs recovers $2.04/MTok for the write.
// Billing the undivided total at 1.25 under-counted by 31.5%.
//
// The halves are stored beside the existing totals rather than replacing them,
// so `billable_tokens` can be re-derived from a stored row and checked against
// the cost the CLI reported. Rows written before this — and rows whose wire
// line carried no breakdown — leave both at 0, and the undivided remainder
// re-derives at the 1-hour rate, exactly as `billableTokens` charged it.
//
// [CODE] Additive. No data rewrite: the existing totals are unchanged.
// ===========================================================================

/** The 0025_cache_write_split migration body. */
export const CACHE_WRITE_SPLIT = /* sql */ `
ALTER TABLE extraction_runs ADD COLUMN cache_creation_5m_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE extraction_runs ADD COLUMN cache_creation_1h_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN cache_create_5m INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN cache_create_1h INTEGER NOT NULL DEFAULT 0;
`;
