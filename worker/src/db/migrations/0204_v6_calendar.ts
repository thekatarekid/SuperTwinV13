// ===========================================================================
// 0204_v6_calendar — V6 P1 S5.3 (Build §8 lane C, Product_V6_Phase1 §12 +
// §16, Product_V6 §11.6 / §11.8.4 / §11.9).
//
// The DERIVED calendar. P1 reads no external calendar and writes none back;
// everything here is built from what the twin already knows:
//
//   calendar_events  chat-derived events ("dinner sat 8pm") and the ones the
//                    bar creates. `starts_at` is the absolute UTC instant; `tz`
//                    is the zone the phrase was resolved in (the user's zone at
//                    MESSAGE time); `phrase` + `message_ts` keep the original
//                    words and their anchor. Status is `tentative` until a user
//                    or a booking confirms it (CAL-01).
//   calendar_rules   recurring phrases ("rent every 1st") as RULES, not dates
//                    (§11.6.4). Born `proposed` — a recurrence is ALWAYS a
//                    confirm suggestion (CAL-04, SCH-04).
//   person_dates     birthdays, anniversaries, exams, flights per person. Year
//                    NULL = yearly. `mode` / `lead_days` NULL = the circle's
//                    default (Settings › Calendar); a snooze learns them per
//                    person.
//   calendar_plans   one row per (date, occurrence): the lead-time plan that
//                    opens a space at T minus lead time, snoozable (CAL-02).
//
// Tasks with due dates and the twin's scheduled steps are NOT copied here —
// the layers read `tasks` directly. Additive; fresh installs only in V6.
// ===========================================================================

export const V6_CALENDAR = /* sql */ `
CREATE TABLE IF NOT EXISTS calendar_events (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  starts_at        TEXT NOT NULL,            -- absolute UTC ISO-8601
  ends_at          TEXT,
  tz               TEXT NOT NULL,            -- IANA zone the phrase resolved in
  all_day          INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'tentative',  -- tentative|confirmed|cancelled
  origin           TEXT NOT NULL DEFAULT 'chat',       -- chat|bar|booking|user
  phrase           TEXT,                     -- the original words, kept verbatim
  message_ts       TEXT,                     -- the anchor the phrase resolved against
  evidence_json    TEXT,                     -- [{event_ids[], quote}]
  space_id         TEXT REFERENCES spaces(id) ON DELETE SET NULL,
  person_entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
  confirmed_at     TEXT,
  confirmed_by     TEXT,                     -- user|booking
  created_by       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_starts ON calendar_events(starts_at, status);

CREATE TABLE IF NOT EXISTS calendar_rules (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  rule_json     TEXT NOT NULL,               -- {freq, interval, by_month_day?, by_weekday?, time?}
  phrase        TEXT,
  message_ts    TEXT,
  tz            TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'proposed',     -- proposed|confirmed|dismissed
  space_id      TEXT REFERENCES spaces(id) ON DELETE SET NULL,
  evidence_json TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  confirmed_at  TEXT,
  updated_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_calendar_rules_status ON calendar_rules(status);

CREATE TABLE IF NOT EXISTS person_dates (
  id               TEXT PRIMARY KEY,
  person_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL DEFAULT 'other',     -- birthday|anniversary|exam|flight|other
  label            TEXT,
  month            INTEGER NOT NULL,
  day              INTEGER NOT NULL,
  year             INTEGER,                  -- NULL = every year
  mode             TEXT,                     -- plan|wish, NULL = circle default
  lead_days        INTEGER,                  -- NULL = circle default; a snooze learns it
  evidence_json    TEXT,
  created_by       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_person_dates_person ON person_dates(person_entity_id);
CREATE INDEX IF NOT EXISTS idx_person_dates_when   ON person_dates(month, day);

CREATE TABLE IF NOT EXISTS calendar_plans (
  id             TEXT PRIMARY KEY,
  person_date_id TEXT NOT NULL REFERENCES person_dates(id) ON DELETE CASCADE,
  occurrence     TEXT NOT NULL,              -- yyyy-mm-dd of this year's date
  lead_days      INTEGER NOT NULL,
  opens_at       TEXT NOT NULL,              -- yyyy-mm-dd = occurrence - lead_days
  status         TEXT NOT NULL DEFAULT 'pending',  -- pending|opened|snoozed|stopped|done
  snoozed_until  TEXT,
  snooze_choice  TEXT,
  space_id       TEXT REFERENCES spaces(id) ON DELETE SET NULL,
  opened_at      TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT,
  UNIQUE (person_date_id, occurrence)
);

CREATE INDEX IF NOT EXISTS idx_calendar_plans_status ON calendar_plans(status, opens_at);
`;
