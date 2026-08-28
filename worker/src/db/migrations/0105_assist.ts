// ===========================================================================
// 0105_assist — build P2.2, spec §10.
//
// The assist lane's durable state:
//
//   * `artifacts` — prepared work (spec §10.5). The popup nudge is ephemeral;
//     the artifact is the durable object with the full status lifecycle
//     new → seen / dismissed / graduated / expired, shown in the menu-bar
//     Prepared list, the Home shelf and Timeline. `content_key` is the dedup
//     fingerprint: identical re-captured content must NEVER mint (or nudge)
//     a second artifact.
//   * `artifact_signals` — graded reconcile signals from UI telemetry
//     (spec §10.6): edited/used > opened+dwelled > glanced; dismissed and
//     ignored are negative. Graduation reads the ledger, never one click.
//   * `assist_topics` — the per-topic novelty accumulator + hygiene state the
//     §10.1 trigger gate keeps IN CODE: distinct cross-source event counts,
//     new-content counts, seen content-hashes (re-observations increment
//     nothing), cooldowns, dismissal suppression.
//   * `assist_cursor` — the watcher's tail position in the event log. Assist
//     has NO capture path of its own (spec §10.2): it reads the same events
//     every lane reads, from this cursor forward.
// ===========================================================================

/** The 0105_assist migration body. */
export const ASSIST = /* sql */ `
-- ---- artifacts: durable prepared work (spec §10.5) -------------------------

CREATE TABLE IF NOT EXISTS artifacts (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,                 -- comparison|draft|brief|checklist|...
  title         TEXT NOT NULL,
  summary       TEXT,                          -- the "what I did" one-liner
  body_json     TEXT,                          -- the artifact payload
  intent        TEXT,                          -- the inferred goal line
  reasoning     TEXT,                          -- the twin always shows its reasoning
  space_id      TEXT REFERENCES spaces(id) ON DELETE SET NULL,
  task_id       TEXT REFERENCES tasks(id)  ON DELETE SET NULL,
  topic_key     TEXT,                          -- assist_topics.topic_key it came from
  content_key   TEXT,                          -- dedup fingerprint (never re-nudge identical content)
  producer      TEXT NOT NULL DEFAULT 'assist',-- 'assist' | 'executor'
  status        TEXT NOT NULL DEFAULT 'new',   -- new|seen|dismissed|graduated|expired
  run_id        TEXT,                          -- runs.id of the evaluator call
  nudged_at     TEXT,                          -- when the transient nudge card fired
  seen_at       TEXT,
  dismissed_at  TEXT,
  graduated_at  TEXT,
  expires_at    TEXT,                          -- moment-bound items auto-archive past this
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_artifacts_status  ON artifacts(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_content ON artifacts(content_key);
CREATE INDEX IF NOT EXISTS idx_artifacts_space   ON artifacts(space_id, status);

-- ---- artifact_signals: graded reconcile telemetry (spec §10.6) -------------

CREATE TABLE IF NOT EXISTS artifact_signals (
  id          TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  signal      TEXT NOT NULL,                   -- edited|used_in_followup|opened_dwelled|glanced|ignored|dismissed|dont_do_this
  weight      REAL NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_artifact_signals ON artifact_signals(artifact_id, created_at);

-- ---- assist_topics: the code trigger gate's accumulator (spec §10.1) -------

CREATE TABLE IF NOT EXISTS assist_topics (
  topic_key          TEXT PRIMARY KEY,          -- space:<id> | bridge:<kind>:<value> | stream:<key>
  category           TEXT,                      -- transaction|research|default (threshold row)
  weighted_count     INTEGER NOT NULL DEFAULT 0,-- cross-source events count double
  new_content_count  INTEGER NOT NULL DEFAULT 0,
  sources_json       TEXT NOT NULL DEFAULT '[]',-- distinct sources seen, order of arrival
  seen_hashes_json   TEXT NOT NULL DEFAULT '[]',-- content hashes already counted
  seen_refs_json     TEXT NOT NULL DEFAULT '[]',-- urls/doc keys already counted (re-visit = not new content)
  event_ids_json     TEXT NOT NULL DEFAULT '[]',-- events in the accumulator (evaluator tail)
  last_event_ts      TEXT,
  cooldown_until     TEXT,                      -- per-context cooldown after any nudge
  dismiss_count      INTEGER NOT NULL DEFAULT 0,
  suppressed_until   TEXT,                      -- set after 2 dismissals in this context
  updated_at         TEXT
);

-- ---- assist_cursor: the watcher's event-log tail position ------------------

CREATE TABLE IF NOT EXISTS assist_cursor (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  last_rowid INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
`;
