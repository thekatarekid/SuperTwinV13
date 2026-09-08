// Phase 0a decision seed. Pure SQLite on a scratch home; zero network/model calls.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../connection.js";
import { decisionsFor } from "../decisions.js";
import { MIGRATIONS } from "../schema.js";
import {
  CHATGPT_PROVIDER_DECISION_RECORDS,
  CHATGPT_PROVIDER_DECISIONS,
  HERMES_REFERENCE_COMMIT,
  type ProviderDecisionSeed,
} from "./0211_chatgpt_provider_decisions.js";

interface ProviderDecisionPayload {
  status: string;
  decision: string;
  rationale: string;
  residualRisk: string;
  acceptingOwner: string;
  acceptedAt: string;
  referenceUrl: string | null;
  referenceCommit: string | null;
  details: Record<string, unknown>;
}

let scratchHome: string;

beforeEach(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "supertwin-0211-"));
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

function seededRows(): Array<ProviderDecisionSeed & { payload: ProviderDecisionPayload }> {
  return CHATGPT_PROVIDER_DECISION_RECORDS.map((record) => {
    const rows = decisionsFor("provider_rollout", record.targetId);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.id).toBe(record.id);
    expect(row.pass).toBe("user");
    expect(row.action).toBe("accept");
    expect(row.reason).toBe(record.rationale);
    expect(row.confidence).toBe(1);
    return { ...record, payload: JSON.parse(row.newJson!) as ProviderDecisionPayload };
  });
}

describe("0211_chatgpt_provider_decisions", () => {
  it("keeps the three original accepted Appendix A decisions in the canonical ledger", () => {
    runMigrations();

    const ids = MIGRATIONS.map((migration) => migration.id);
    expect(ids.indexOf("0211_chatgpt_provider_decisions")).toBe(
      ids.indexOf("0210_v6_extract_queue") + 1,
    );

    const count = getDb()
      .prepare(`SELECT COUNT(*) AS count FROM decisions WHERE target_kind = 'provider_rollout'`)
      .get() as { count: number };
    // The append-only A.1.1 browser-PKCE amendment is a fourth, separate row.
    expect(count.count).toBe(4);

    const rows = seededRows();
    expect(rows.map((row) => row.targetId)).toEqual([
      "chatgpt-oauth:client_identity",
      "chatgpt-oauth:terms_risk",
      "chatgpt-oauth:consumer_data_consent",
    ]);
    expect(rows.every((row) => row.payload.status === "accepted")).toBe(true);
    expect(rows.every((row) => row.payload.acceptingOwner === "Aditya Katare")).toBe(true);
    expect(rows.every((row) => row.payload.acceptedAt === "2026-09-07")).toBe(true);
    expect(rows.every((row) => row.payload.rationale.length > 0)).toBe(true);
    expect(rows.every((row) => row.payload.residualRisk.length > 0)).toBe(true);

    for (const [index, record] of CHATGPT_PROVIDER_DECISION_RECORDS.entries()) {
      expect(rows[index].payload).toEqual({
        status: "accepted",
        decision: record.decision,
        rationale: record.rationale,
        residualRisk: record.residualRisk,
        acceptingOwner: record.acceptingOwner,
        acceptedAt: record.acceptedAt,
        referenceUrl: record.referenceUrl ?? null,
        referenceCommit: record.referenceCommit ?? null,
        details: record.details,
      });
    }
    expect(rows[0].payload.referenceCommit).toBe(HERMES_REFERENCE_COMMIT);
    expect(rows[0].payload.details).toEqual(
      expect.objectContaining({
        oauth: expect.objectContaining({
          clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
          loopbackListener: false,
          deviceRequestContentType: "application/json",
          devicePollContentType: "application/json",
          tokenExchangeContentType: "application/x-www-form-urlencoded",
        }),
        inference: expect.objectContaining({
          responsesUrl: "https://chatgpt.com/backend-api/codex/responses",
          requestIdentifiers: {
            headers: ["session_id", "x-client-request-id"],
            bounded: true,
            identityImpersonation: false,
          },
        }),
        authMechanics: expect.objectContaining({
          exchangeServerReturnedAuthorizationCode: true,
          exchangeServerReturnedVerifier: true,
          refreshAttemptsAfter401: 1,
          retryOriginalRequestAfterRefresh: 1,
        }),
        rollout: expect.objectContaining({ defaultEnabled: false }),
      }),
    );
    expect(rows[1].payload.details).toEqual(
      expect.objectContaining({
        acceptedPosture: expect.objectContaining({
          concurrencyAtLeastEight: true,
          riskAcceptanceIsAuthorization: false,
        }),
        circumventRestrictions: false,
      }),
    );
    expect(rows[2].payload.details).toEqual(
      expect.objectContaining({
        treatment: expect.stringContaining("consumer-service"),
        differsFromClaude: expect.stringContaining("Anthropic"),
      }),
    );
  });

  it("is idempotent and preserves the fresh-home zero-content invariant", () => {
    runMigrations();
    const db = getDb();
    const first = seededRows();

    db.exec(CHATGPT_PROVIDER_DECISIONS);
    runMigrations();

    expect(seededRows()).toEqual(first);
    for (const table of ["events", "sources", "streams"]) {
      const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
      expect(row.count, table).toBe(0);
    }
  });

  it("upgrades a populated ledger and never overwrites a local amendment", () => {
    runMigrations();
    const db = getDb();
    db.prepare(`UPDATE decisions SET new_json = ? WHERE id = ?`).run(
      JSON.stringify({ status: "locally-amended" }),
      CHATGPT_PROVIDER_DECISION_RECORDS[0].id,
    );
    db.prepare(
      `INSERT INTO decisions (id, pass, target_kind, target_id, action, new_json, reason)
       VALUES ('dec_existing_user_row', 'user', 'setting', 'existing', 'update', '{}', 'keep me')`,
    ).run();
    db.prepare(`DELETE FROM schema_migrations WHERE id = '0211_chatgpt_provider_decisions'`).run();

    runMigrations();
    runMigrations();

    expect(
      db.prepare(`SELECT new_json FROM decisions WHERE id = ?`).get(
        CHATGPT_PROVIDER_DECISION_RECORDS[0].id,
      ),
    ).toEqual({ new_json: JSON.stringify({ status: "locally-amended" }) });
    expect(
      db.prepare(`SELECT reason FROM decisions WHERE id = 'dec_existing_user_row'`).get(),
    ).toEqual({ reason: "keep me" });
    expect(
      db
        .prepare(`SELECT COUNT(*) AS count FROM decisions WHERE target_kind = 'provider_rollout'`)
        .get(),
    ).toEqual({ count: 4 });
  });
});
