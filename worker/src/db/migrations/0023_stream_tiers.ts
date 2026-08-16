// ===========================================================================
// 0023_stream_tiers — where a stream's tier is kept (arch §9.3, build item 1.2).
//
// §9.3 rule 2: "Tier is a property of the stream, computed once and STORED —
// never re-derived per event, never a per-message judgment." So it is a column
// on `streams`, not a view over `events`.
//
// §9.3 rule 4 is the reason the columns beside `tier` exist. The prior build
// shipped tiering with `tier NULL` on all 97 channels and nobody noticed,
// because nothing recorded who assigned a tier or when. Every assignment here
// writes its provenance:
//
//   tier             T1 | T2 | T3 | T4  — NULL only before the boot backfill
//   tier_rule        the [CODE] rule that fired, or the P-TI1 verdict applied
//   tier_source      'code' | 'p-ti1'   — which executor decided
//   tier_confidence  the model's number for a P-TI1 verdict, NULL for [CODE]
//   tier_reason      the model's words, verbatim, or the rule's own sentence
//   tier_assigned_at when, so a coverage assertion can name what it is missing
//   tier_sample_hash the fingerprint of the sample P-TI1 judged, so §9.3's
//                    "cached on the stream, re-run only if the channel's
//                    character changes" is a comparison and not a promise
//
// `is_business` moves onto `streams` here. It has lived on the legacy
// `channels` mirror since 0012 and the tier rules need it: nothing new may read
// `channels` (arch §3.3 leak 6), and a tier derived from a legacy table would
// be exactly that leak wearing a different hat.
//
// [CODE] Fresh install only. No data migration, no backfill of old rows: the
// tier backfill is a boot-time pass in worker/src/tiers/derive.ts, which is
// where the coverage assertion lives too.
// ===========================================================================

/** The 0023_stream_tiers migration body. */
export const STREAM_TIERS = /* sql */ `
ALTER TABLE streams ADD COLUMN is_business      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE streams ADD COLUMN tier             TEXT;
ALTER TABLE streams ADD COLUMN tier_rule        TEXT;
ALTER TABLE streams ADD COLUMN tier_source      TEXT;
ALTER TABLE streams ADD COLUMN tier_confidence  REAL;
ALTER TABLE streams ADD COLUMN tier_reason      TEXT;
ALTER TABLE streams ADD COLUMN tier_assigned_at TEXT;
ALTER TABLE streams ADD COLUMN tier_sample_hash TEXT;

-- The scheduler's primary sort key is read per stream and swept for NULLs by
-- the boot coverage assertion; both want this index.
CREATE INDEX IF NOT EXISTS idx_streams_tier ON streams(tier);
`;
