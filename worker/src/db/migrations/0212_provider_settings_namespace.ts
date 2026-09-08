// Provider-keyed model/reasoning settings migration (ChatGPT V2 §9.2).
//
// The inventory intentionally contains 21 source entries but 19 distinct keys:
// the Settings picker and internal role namespaces share `chat` and `extract`.
// INSERT OR IGNORE makes an existing provider-keyed choice authoritative and
// makes replay/crash recovery idempotent. Legacy rows remain for one release.

export const PROVIDER_SETTINGS_SOURCE_KEYS = [
  "orient", "critic", "extract", "decide", "digest", "consolidate",
  "assist", "executor", "chat", "tier", "brief",
  "chat", "media", "entity", "episode", "arc", "extract", "triage",
  "done_detect", "classify", "adjudicate",
] as const;

export const PROVIDER_SETTINGS_KEYS: readonly string[] = [
  ...new Set(PROVIDER_SETTINGS_SOURCE_KEYS),
];

const legacyModelKeys = PROVIDER_SETTINGS_KEYS.map(
  (key) => `'selected_model_${key}'`,
).join(", ");
const legacyReasoningKeys = PROVIDER_SETTINGS_KEYS.map(
  (key) => `'selected_thinking_${key}'`,
).join(", ");

function legacyMirrorTrigger(
  name: string,
  event: "INSERT" | "UPDATE",
  legacyKeys: string,
  legacyPrefix: string,
  providerPrefix: string,
): string {
  return `
CREATE TRIGGER IF NOT EXISTS ${name}
AFTER ${event} ON app_state
WHEN NEW.key IN (${legacyKeys})
BEGIN
  INSERT INTO app_state (key, value, updated_at)
  VALUES (
    '${providerPrefix}' || substr(NEW.key, length('${legacyPrefix}') + 1),
    NEW.value,
    NEW.updated_at
  )
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    updated_at = excluded.updated_at;
END;`;
}

export const PROVIDER_SETTINGS_NAMESPACE = `
INSERT OR IGNORE INTO app_state (key, value, updated_at)
SELECT
  'ai.model.claude-local.' || substr(key, length('selected_model_') + 1),
  value,
  updated_at
FROM app_state
WHERE key IN (${legacyModelKeys});

-- The oldest single-model setting belonged to chat. A newer per-chat row was
-- copied above and wins through INSERT OR IGNORE when both generations exist.
INSERT OR IGNORE INTO app_state (key, value, updated_at)
SELECT 'ai.model.claude-local.chat', value, updated_at
FROM app_state
WHERE key = 'selected_model';

INSERT OR IGNORE INTO app_state (key, value, updated_at)
SELECT
  'ai.reasoning.claude-local.' || substr(key, length('selected_thinking_') + 1),
  value,
  updated_at
FROM app_state
WHERE key IN (${legacyReasoningKeys});

${legacyMirrorTrigger(
  "provider_settings_model_insert",
  "INSERT",
  legacyModelKeys,
  "selected_model_",
  "ai.model.claude-local.",
)}
${legacyMirrorTrigger(
  "provider_settings_model_update",
  "UPDATE",
  legacyModelKeys,
  "selected_model_",
  "ai.model.claude-local.",
)}
${legacyMirrorTrigger(
  "provider_settings_reasoning_insert",
  "INSERT",
  legacyReasoningKeys,
  "selected_thinking_",
  "ai.reasoning.claude-local.",
)}
${legacyMirrorTrigger(
  "provider_settings_reasoning_update",
  "UPDATE",
  legacyReasoningKeys,
  "selected_thinking_",
  "ai.reasoning.claude-local.",
)}
`;
