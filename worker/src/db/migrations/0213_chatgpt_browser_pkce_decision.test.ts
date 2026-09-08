// Additive browser-PKCE governance row. SQLite only; zero network/model calls.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { closeDb, getDb, runMigrations } from "../connection.js";
import { decisionsFor } from "../decisions.js";
import { MIGRATIONS } from "../schema.js";
import {
  CHATGPT_BROWSER_PKCE_DECISION,
  CHATGPT_BROWSER_PKCE_DECISION_RECORD,
  MUESLI_REFERENCE_COMMIT,
} from "./0213_chatgpt_browser_pkce_decision.js";
import { CHATGPT_PROVIDER_DECISIONS } from "./0211_chatgpt_provider_decisions.js";

let scratchHome: string;

beforeEach(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "supertwin-0213-"));
  process.env.SUPERTWIN_HOME = scratchHome;
  delete process.env.SUPERTWIN_DB_PATH;
  closeDb();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_HOME;
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(scratchHome, { recursive: true, force: true });
});

function seedAmendment(): void {
  getDb().exec(CHATGPT_BROWSER_PKCE_DECISION);
}

function payload(): Record<string, unknown> {
  const rows = decisionsFor(
    "provider_rollout",
    CHATGPT_BROWSER_PKCE_DECISION_RECORD.targetId,
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: CHATGPT_BROWSER_PKCE_DECISION_RECORD.id,
    pass: "user",
    action: "accept",
    reason: CHATGPT_BROWSER_PKCE_DECISION_RECORD.rationale,
    confidence: 1,
  });
  return JSON.parse(rows[0].newJson!) as Record<string, unknown>;
}

describe("0213_chatgpt_browser_pkce_decision", () => {
  it("appends the accepted browser-PKCE amendment to an upgraded ledger without rewriting the three original rows", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE decisions (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      pass TEXT,
      target_kind TEXT,
      target_id TEXT,
      action TEXT,
      old_json TEXT,
      new_json TEXT,
      reason TEXT,
      confidence REAL
    )`);
    db.exec(CHATGPT_PROVIDER_DECISIONS);
    const originals = db
      .prepare(
        `SELECT id, new_json FROM decisions
         WHERE target_kind = 'provider_rollout' AND id <> ? ORDER BY id`,
      )
      .all(CHATGPT_BROWSER_PKCE_DECISION_RECORD.id) as Array<{
      id: string;
      new_json: string;
    }>;
    expect(originals).toHaveLength(3);

    db.exec(CHATGPT_BROWSER_PKCE_DECISION);

    expect(
      db
        .prepare(
          `SELECT id, new_json FROM decisions
           WHERE target_kind = 'provider_rollout' AND id <> ? ORDER BY id`,
        )
        .all(CHATGPT_BROWSER_PKCE_DECISION_RECORD.id),
    ).toEqual(originals);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM decisions
           WHERE target_kind = 'provider_rollout'`,
        )
        .get(),
    ).toEqual({ count: 4 });

    const appended = db
      .prepare(`SELECT new_json FROM decisions WHERE id = ?`)
      .get(CHATGPT_BROWSER_PKCE_DECISION_RECORD.id) as { new_json: string };
    expect(JSON.parse(appended.new_json)).toEqual(expect.objectContaining({
      status: "accepted",
      acceptingOwner: "Aditya Katare",
      referenceCommit: MUESLI_REFERENCE_COMMIT,
    }));
    db.close();
  });

  it("is registered directly after the provider-settings namespace migration", () => {
    const ids = MIGRATIONS.map((migration) => migration.id);
    expect(ids.indexOf("0213_chatgpt_browser_pkce_decision")).toBe(
      ids.indexOf("0212_provider_settings_namespace") + 1,
    );
  });

  it("is idempotent and preserves a local amendment", () => {
    runMigrations();
    const db = getDb();
    const local = JSON.stringify({ status: "locally-amended" });
    db.prepare(`UPDATE decisions SET new_json = ? WHERE id = ?`).run(
      local,
      CHATGPT_BROWSER_PKCE_DECISION_RECORD.id,
    );

    seedAmendment();
    seedAmendment();

    expect(
      db.prepare(`SELECT new_json FROM decisions WHERE id = ?`).get(
        CHATGPT_BROWSER_PKCE_DECISION_RECORD.id,
      ),
    ).toEqual({ new_json: local });
  });

  it("records exact product-only ceremony boundaries and preserved 3/55 evidence", () => {
    runMigrations();
    const record = payload();
    const details = record.details as Record<string, Record<string, unknown>>;

    expect(details.endpoints).toEqual({
      authorize: "https://auth.openai.com/oauth/authorize",
      token: "https://auth.openai.com/oauth/token",
      redirectUri: "http://localhost:1455/auth/callback",
    });
    expect(details.authorizationParameters).toEqual({
      clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
      redirectUri: "http://localhost:1455/auth/callback",
      responseType: "code",
      scope: "openid profile email offline_access",
      codeChallengeMethod: "S256",
      idTokenAddOrganizations: "true",
      codexCliSimplifiedFlow: "true",
      originator: "supertwinv13",
      independentHighEntropyState: true,
      independentHighEntropyVerifier: true,
    });
    expect(details.exchangeParameters).toEqual({
      grantType: "authorization_code",
      clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
      returnedAuthorizationCodeRequired: true,
      exactRedirectUri: true,
      codeVerifierRequired: true,
    });
    expect(details.refreshParameters).toEqual({
      grantType: "refresh_token",
      clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
      currentRefreshTokenRequired: true,
      followsOriginalRotationProtocol: true,
    });
    expect(details.userExperience).toMatchObject({
      automaticCallbackCompletion: true,
      successHeading: "Signed in to SuperTwin",
      authorizationCodeEntryUi: false,
    });
    expect(details.callbackSecurity).toMatchObject({
      bindHost: "127.0.0.1",
      port: 1455,
      method: "GET",
      path: "/auth/callback",
      timingSafeStateValidation: true,
      singleUse: true,
    });
    expect(details.fallbacksAllowed).toEqual({
      deviceCodeInProduction: false,
      apiKey: false,
      codexCli: false,
      automaticClaudeFallback: false,
    });
    expect(details.claudeLocalRemainsSeparateProvider).toBe(true);
    expect(details.historicalDeviceCodeDisposition).toMatchObject({
      retainedOnlyUnder: "worker/src/providers/chatgpt-oauth/probe/",
      productImportOrRoute: false,
      automaticFallback: false,
    });
    expect(details.transportEvidence).toEqual({
      cumulativeInferenceAttemptsConsumed: 3,
      cumulativeInferenceAttemptsAuthorized: 55,
      ceremonyChangeAddsInferenceAuthorization: false,
    });
  });
});
