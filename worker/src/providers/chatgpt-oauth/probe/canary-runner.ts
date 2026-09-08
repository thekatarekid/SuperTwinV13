import {
  LIVE_CANARY_HTTP_LIMITS,
  ProbeHttpAccounting,
  type ProbeHttpCounts,
} from "./accounting.js";
import { CODEX_MODELS_URL, CODEX_USAGE_URL } from "./constants.js";
import {
  buildContractCaseMismatchDiagnostic,
  contractListeningSocketCount,
  executeContractProbeCase,
  fetchContractMetadataJson,
  type ContractCaseMismatchDiagnostic,
  type ContractProbeHooks,
} from "./contract-runner.js";
import { runDeviceCodeFlow } from "./device-flow.js";
import { buildContractProbeMatrix } from "./matrix.js";
import { parseProbeModelCatalogue, selectRequestedProbeModel } from "./models.js";
import { compareProbeQuota, parseProbeQuota, type ProbeQuotaEvidence } from "./quota.js";
import { hasModelCatalogueRestrictionSignal } from "./restriction.js";
import { EphemeralProbeTokenSession, type SafeSessionEvidence } from "./refresh.js";
import { buildBackendHeaders } from "./requests.js";
import {
  assertLiveCanaryProbeAccount,
  assertLiveCanaryProbePreflight,
} from "./safety.js";
import { enforceScratchHomeInvariant } from "./scratch.js";
import {
  bindLiveInferenceAuthorizationPlan,
  markLiveCanaryInferenceMatched,
  prepareLiveInferenceAuthorization,
  reserveLiveCanaryInferencePost,
} from "./live-authorization.js";
import type {
  CanaryInferenceReservation,
} from "./authorization-ledger.js";

export interface CanaryProbeHooks extends ContractProbeHooks {}

export interface CanaryProbeEvidence {
  mode: "canary-only";
  evidenceCompleteness: "single-canary-only";
  scratchHomeProof: "no-residual-artifacts";
  persistedCredentials: false;
  inferenceRetries: 0;
  actualInferencePosts: 1;
  accountFingerprint: string;
  model: { status: number; responseBytes: number; selectedId: string };
  quota: ProbeQuotaEvidence & { status: number; responseBytes: number };
  finalQuota: ProbeQuotaEvidence & { status: number; responseBytes: number };
  refresh: SafeSessionEvidence;
  canary: ContractCaseMismatchDiagnostic;
  checkpoint: {
    state: "matched";
    caseSequence: 1;
    caseName: "canary.blank-context";
    acceptancePolicyVersion: "phase0b-canary-success-v1";
    reservationPost: number;
  };
  httpActuals: ProbeHttpCounts;
  logout: SafeSessionEvidence;
  localListeningSocketsCreated: false;
}

export async function runCanaryProbe(hooks: CanaryProbeHooks): Promise<CanaryProbeEvidence> {
  const env = { ...(hooks.env ?? process.env) };
  assertLiveCanaryProbePreflight(env);
  const authorization = await prepareLiveInferenceAuthorization("canary", env);
  let completedAuthorization: Awaited<ReturnType<typeof bindLiveInferenceAuthorizationPlan>> | undefined;
  let completedReservation: CanaryInferenceReservation | undefined;
  const evidence: Omit<CanaryProbeEvidence, "checkpoint"> = await enforceScratchHomeInvariant(env, async () => {
    const listeningSocketsBefore = contractListeningSocketCount();
    const accounting = new ProbeHttpAccounting(LIVE_CANARY_HTTP_LIMITS);
    const probeAbort = new AbortController();
    const signals = [hooks.signal, probeAbort.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    const probeHooks: CanaryProbeHooks = {
      ...hooks,
      env,
      fetch: accounting.wrap(hooks.fetch, AbortSignal.any(signals)),
      signal: AbortSignal.any(signals),
    };
    let session: EphemeralProbeTokenSession | undefined;
    let primaryFailure: unknown;
    try {
      const tokens = await runDeviceCodeFlow(probeHooks);
      session = new EphemeralProbeTokenSession(tokens);
      const account = assertLiveCanaryProbeAccount(tokens.accessToken, env);
      let headers = buildBackendHeaders(tokens.accessToken, account.accountId, env);

      const modelsResponse = await fetchContractMetadataJson(CODEX_MODELS_URL, headers, probeHooks);
      if (hasModelCatalogueRestrictionSignal(modelsResponse.value)) {
        throw new Error(`Canary probe stopped on upstream restriction (HTTP ${modelsResponse.status})`);
      }
      const catalogue = parseProbeModelCatalogue(modelsResponse.value);
      if (!catalogue.models.length) throw new Error("Canary model catalogue contains no safe visible model IDs");
      const model = selectRequestedProbeModel(catalogue, undefined, env);
      const boundAuthorization = await bindLiveInferenceAuthorizationPlan(
        authorization,
        catalogue,
        model.id,
        env,
      );

      const quotaResponse = await fetchContractMetadataJson(CODEX_USAGE_URL, headers, probeHooks);
      const quota = parseProbeQuota(quotaResponse.value);
      if (!quota.healthy) throw new Error("Canary account is quota-limited or restricted at start");

      const refreshed = await session.refresh(probeHooks);
      const refreshedAccount = assertLiveCanaryProbeAccount(refreshed.accessToken, env);
      if (refreshedAccount.fingerprint !== account.fingerprint) {
        throw new Error("REFUSED: OAuth refresh changed the dedicated Phase 0b account");
      }
      headers = buildBackendHeaders(refreshed.accessToken, refreshedAccount.accountId, env);
      const refresh = session.evidence();

      const canary = buildContractProbeMatrix(catalogue, model.id, env)[0];
      if (!canary || canary.name !== "canary.blank-context" || canary.sequence !== 1) {
        throw new Error("Canary-only runner could not resolve the exact first contract case");
      }
      const caseEvidence = await executeContractProbeCase(canary, headers, {
        ...probeHooks,
        reserveInferencePosts: async (posts) => {
          if (posts !== 1 || completedReservation) {
            throw new Error("REFUSED: canary reservation must be exactly one tagged attempt");
          }
          completedReservation = await reserveLiveCanaryInferencePost(boundAuthorization);
        },
      }, new Set());

      const finalQuotaResponse = await fetchContractMetadataJson(CODEX_USAGE_URL, headers, probeHooks);
      const finalQuota = parseProbeQuota(finalQuotaResponse.value);
      compareProbeQuota(quota, finalQuota);
      const finalAccount = assertLiveCanaryProbeAccount(session.current().accessToken, env);
      if (finalAccount.fingerprint !== account.fingerprint) {
        throw new Error("REFUSED: final canary account check changed the dedicated Phase 0b account");
      }
      const actuals = accounting.snapshot();
      if (actuals.deviceCode !== 1 || actuals.devicePoll < 1 || actuals.token !== 2 ||
          actuals.models !== 1 || actuals.quota !== 2 || actuals.inference !== 1 ||
          actuals.other !== 0) {
        throw new Error("Canary-only HTTP accounting did not match its declared flow");
      }
      if (!completedReservation) throw new Error("REFUSED: canary completed without a tagged reservation");
      completedAuthorization = boundAuthorization;

      session.logout();
      const logout = session.evidence();
      if (contractListeningSocketCount() > listeningSocketsBefore) {
        throw new Error("Canary-only probe unexpectedly created a local listening socket");
      }
      const eventStream = caseEvidence.stream !== undefined;
      return {
        mode: "canary-only",
        evidenceCompleteness: "single-canary-only",
        scratchHomeProof: "no-residual-artifacts",
        persistedCredentials: false,
        inferenceRetries: 0,
        actualInferencePosts: 1,
        accountFingerprint: account.fingerprint,
        model: {
          status: modelsResponse.status,
          responseBytes: modelsResponse.bytes,
          selectedId: model.id,
        },
        quota: { status: quotaResponse.status, responseBytes: quotaResponse.bytes, ...quota },
        finalQuota: {
          status: finalQuotaResponse.status,
          responseBytes: finalQuotaResponse.bytes,
          ...finalQuota,
        },
        refresh,
        canary: buildContractCaseMismatchDiagnostic({
          status: caseEvidence.status as number,
          ok: typeof caseEvidence.status === "number" && caseEvidence.status >= 200 && caseEvidence.status < 300,
          body: eventStream ? ({} as ReadableStream<Uint8Array>) : null,
        }, eventStream ? "text/event-stream" : null, caseEvidence.stream),
        httpActuals: actuals,
        logout,
        localListeningSocketsCreated: false,
      };
    } catch (error) {
      primaryFailure = error;
      throw error;
    } finally {
      probeAbort.abort(new Error("Phase 0b canary-only probe finished"));
      session?.logout();
      try {
        hooks.onFinalized?.({
          httpActuals: accounting.snapshot(),
          logout: session?.evidence() ?? {
            authenticated: false,
            hasRefreshToken: false,
            previousRecoveryPairAvailable: false,
          },
          aborted: probeAbort.signal.aborted,
        });
      } catch (finalizationError) {
        if (primaryFailure !== undefined) {
          throw new AggregateError(
            [primaryFailure, finalizationError],
            "Phase 0b canary-only probe failed and finalization also failed",
            { cause: primaryFailure },
          );
        }
        throw finalizationError;
      }
    }
  });
  hooks.signal?.throwIfAborted();
  if (!completedAuthorization || !completedReservation) {
    throw new Error("REFUSED: canary checkpoint inputs were not completed");
  }
  const checkpoint = await markLiveCanaryInferenceMatched(
    completedAuthorization,
    completedReservation,
    hooks.signal,
  );
  return {
    ...evidence,
    checkpoint: {
      state: "matched",
      caseSequence: checkpoint.caseSequence,
      caseName: checkpoint.caseName,
      acceptancePolicyVersion: checkpoint.acceptancePolicyVersion,
      reservationPost: checkpoint.reservationPost,
    },
  };
}
