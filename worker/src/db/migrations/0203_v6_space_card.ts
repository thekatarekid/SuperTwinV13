// ===========================================================================
// 0203_v6_space_card — V6 P1 S3.7 (Build §6.2 lane C, Product_V6_Phase1 §13.1).
//
// The space card carries what decide.v9 writes per space: `summary` (two
// lines, what is true now), `latest` (one line, what just moved) with the
// instant it moved. Milestones are NOT a new table: a staged goal's stages
// are `chapters` rows (status done|active|todo) — "chapters with dates are
// the milestones" (0101), and episodes route to them by chapter_id (DEC-01).
// Plan stays in `plan_json` (0104). Additive; fresh installs only in V6.
// ===========================================================================

export const V6_SPACE_CARD = /* sql */ `
ALTER TABLE spaces ADD COLUMN summary TEXT;
ALTER TABLE spaces ADD COLUMN latest TEXT;
ALTER TABLE spaces ADD COLUMN latest_ts TEXT;
`;
