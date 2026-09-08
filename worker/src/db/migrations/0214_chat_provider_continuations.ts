// ===========================================================================
// 0214_chat_provider_continuations — separate the app's public conversation
// identity from an opaque, provider-owned continuation.
//
// `chat_sessions.session_id` remains the legacy primary key for this additive
// migration so its chat_messages foreign key and existing callers keep working.
// Existing rows receive random UUIDv4 public ids once. UPDATE-only-when-NULL
// makes that backfill stable on replay without exposing predictable ids across
// installs. New callers can supply a random UUID; the fill trigger is a one-
// release compatibility seam for legacy INSERTs that do not know about
// conversation_id yet.
//
// A provider binding may exist while its continuation is NULL: that is the
// intentional reconstruction state. A non-NULL continuation, however, is only
// valid with the complete provider/model/prompt-bundle binding and a positive
// generation. Bindings can change only after the token is already NULL and the
// generation advances; every token change also advances the generation. The
// generation is bounded to a signed 32-bit integer so later compare-and-swap
// updates cannot drift into unsafe JavaScript integer space.
// ===========================================================================

export const CHAT_PROVIDER_CONTINUATIONS = /* sql */ `
ALTER TABLE chat_sessions ADD COLUMN conversation_id TEXT
  CHECK (
    conversation_id IS NULL OR (
      typeof(conversation_id) = 'text'
      AND length(CAST(conversation_id AS BLOB)) = 36
      AND substr(conversation_id, 9, 1) = '-'
      AND substr(conversation_id, 14, 1) = '-'
      AND substr(conversation_id, 19, 1) = '-'
      AND substr(conversation_id, 24, 1) = '-'
      AND length(replace(conversation_id, '-', '')) = 32
      AND replace(conversation_id, '-', '') NOT GLOB '*[^0-9a-f]*'
      AND substr(conversation_id, 15, 1) IN ('1','2','3','4','5','6','7','8')
      AND substr(conversation_id, 20, 1) IN ('8','9','a','b')
    )
  );

ALTER TABLE chat_sessions ADD COLUMN provider_continuation TEXT
  CHECK (
    provider_continuation IS NULL OR (
      typeof(provider_continuation) = 'text'
      AND length(CAST(provider_continuation AS BLOB)) BETWEEN 1 AND 4096
    )
  );

ALTER TABLE chat_sessions ADD COLUMN continuation_provider TEXT
  CHECK (
    continuation_provider IS NULL OR (
      typeof(continuation_provider) = 'text'
      AND length(CAST(continuation_provider AS BLOB)) BETWEEN 1 AND 64
      AND continuation_provider NOT GLOB '*[^a-z0-9._-]*'
    )
  );

ALTER TABLE chat_sessions ADD COLUMN continuation_model TEXT
  CHECK (
    continuation_model IS NULL OR (
      typeof(continuation_model) = 'text'
      AND length(CAST(continuation_model AS BLOB)) BETWEEN 1 AND 256
      AND continuation_model NOT GLOB '*[^A-Za-z0-9._:/+-]*'
    )
  );

ALTER TABLE chat_sessions ADD COLUMN continuation_prompt_bundle_hash TEXT
  CHECK (
    continuation_prompt_bundle_hash IS NULL OR (
      typeof(continuation_prompt_bundle_hash) = 'text'
      AND length(continuation_prompt_bundle_hash) = 64
      AND continuation_prompt_bundle_hash NOT GLOB '*[^0-9a-f]*'
    )
  );

ALTER TABLE chat_sessions ADD COLUMN continuation_generation INTEGER NOT NULL DEFAULT 0
  CHECK (
    typeof(continuation_generation) = 'integer'
    AND continuation_generation BETWEEN 0 AND 2147483647
  );

-- This guard precedes the backfill so even an astronomically unlikely random
-- UUID collision with the row's legacy provider token aborts safely.
CREATE TRIGGER IF NOT EXISTS chat_sessions_conversation_id_update_guard
BEFORE UPDATE OF conversation_id, session_id ON chat_sessions
WHEN NEW.conversation_id IS NULL
  OR NEW.conversation_id = NEW.session_id
  OR (OLD.conversation_id IS NOT NULL AND NEW.conversation_id IS NOT OLD.conversation_id)
BEGIN
  SELECT RAISE(ABORT, 'conversation_id must be immutable, non-null, and distinct from legacy session_id');
END;

-- randomblob() is part of core SQLite. Existing ids never change because only
-- NULL rows are touched, so migration replay is stable without predictable
-- cross-install public identifiers.
UPDATE chat_sessions
   SET conversation_id =
       lower(hex(randomblob(4))) || '-' ||
       lower(hex(randomblob(2))) || '-4' ||
       substr(lower(hex(randomblob(2))), 2) || '-' ||
       substr('89ab', 1 + (random() & 3), 1) ||
       substr(lower(hex(randomblob(2))), 2) || '-' ||
       lower(hex(randomblob(6)))
 WHERE conversation_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_sessions_conversation_id
  ON chat_sessions(conversation_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_sessions_provider_continuation
  ON chat_sessions(continuation_provider, provider_continuation)
  WHERE provider_continuation IS NOT NULL;

-- Existing insert paths omit conversation_id. Give them an unguessable UUIDv4
-- without ever copying the provider's session token into the public identity.
CREATE TRIGGER IF NOT EXISTS chat_sessions_conversation_id_fill
AFTER INSERT ON chat_sessions
WHEN NEW.conversation_id IS NULL
BEGIN
  UPDATE chat_sessions
     SET conversation_id =
       lower(hex(randomblob(4))) || '-' ||
       lower(hex(randomblob(2))) || '-4' ||
       substr(lower(hex(randomblob(2))), 2) || '-' ||
       substr('89ab', 1 + (random() & 3), 1) ||
       substr(lower(hex(randomblob(2))), 2) || '-' ||
       lower(hex(randomblob(6)))
   WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER IF NOT EXISTS chat_sessions_conversation_id_insert_guard
BEFORE INSERT ON chat_sessions
WHEN NEW.conversation_id IS NOT NULL AND NEW.conversation_id = NEW.session_id
BEGIN
  SELECT RAISE(ABORT, 'conversation_id must be distinct from legacy session_id');
END;

CREATE TRIGGER IF NOT EXISTS chat_sessions_continuation_insert_guard
BEFORE INSERT ON chat_sessions
WHEN NOT (
  (
    NEW.continuation_provider IS NULL
    AND NEW.continuation_model IS NULL
    AND NEW.continuation_prompt_bundle_hash IS NULL
    AND NEW.provider_continuation IS NULL
  ) OR (
    NEW.continuation_provider IS NOT NULL
    AND NEW.continuation_model IS NOT NULL
    AND NEW.continuation_prompt_bundle_hash IS NOT NULL
    AND NEW.continuation_generation >= 1
  )
)
BEGIN
  SELECT RAISE(ABORT, 'provider continuation requires a complete binding and positive generation');
END;

CREATE TRIGGER IF NOT EXISTS chat_sessions_continuation_update_guard
BEFORE UPDATE OF provider_continuation, continuation_provider,
                 continuation_model, continuation_prompt_bundle_hash,
                 continuation_generation ON chat_sessions
WHEN NOT (
  (
    NEW.continuation_provider IS NULL
    AND NEW.continuation_model IS NULL
    AND NEW.continuation_prompt_bundle_hash IS NULL
    AND NEW.provider_continuation IS NULL
  ) OR (
    NEW.continuation_provider IS NOT NULL
    AND NEW.continuation_model IS NOT NULL
    AND NEW.continuation_prompt_bundle_hash IS NOT NULL
    AND NEW.continuation_generation >= 1
  )
)
BEGIN
  SELECT RAISE(ABORT, 'provider continuation requires a complete binding and positive generation');
END;

CREATE TRIGGER IF NOT EXISTS chat_sessions_continuation_binding_transition
BEFORE UPDATE OF continuation_provider, continuation_model,
                 continuation_prompt_bundle_hash,
                 provider_continuation, continuation_generation ON chat_sessions
WHEN (
  NEW.continuation_provider IS NOT OLD.continuation_provider
  OR NEW.continuation_model IS NOT OLD.continuation_model
  OR NEW.continuation_prompt_bundle_hash IS NOT OLD.continuation_prompt_bundle_hash
) AND NOT (
  OLD.provider_continuation IS NULL
  AND NEW.provider_continuation IS NULL
  AND NEW.continuation_generation > OLD.continuation_generation
)
BEGIN
  SELECT RAISE(ABORT, 'provider continuation rebind requires a null token and generation advance');
END;

CREATE TRIGGER IF NOT EXISTS chat_sessions_continuation_token_transition
BEFORE UPDATE OF provider_continuation, continuation_generation ON chat_sessions
WHEN NEW.provider_continuation IS NOT OLD.provider_continuation
  AND NEW.continuation_generation <= OLD.continuation_generation
BEGIN
  SELECT RAISE(ABORT, 'provider continuation token change requires generation advance');
END;

CREATE TRIGGER IF NOT EXISTS chat_sessions_continuation_generation_monotonic
BEFORE UPDATE OF continuation_generation ON chat_sessions
WHEN NEW.continuation_generation < OLD.continuation_generation
BEGIN
  SELECT RAISE(ABORT, 'provider continuation generation cannot decrease');
END;
`;
