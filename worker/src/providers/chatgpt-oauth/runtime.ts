import { appStateGet, appStateSet } from "../../db/ingest.js";
import { getActiveProvider } from "../../db/settings.js";
import { registerV2 } from "../registry.js";
import { providerCatalogueCacheKey, type ProviderCatalogueStore } from "../catalogue.js";
import type { ProviderAuthState, ProviderModelCatalogue, ProviderV2 } from "../types.js";
import {
  assertProviderQuotaAvailable,
  chatGptQuotaStatus,
  invalidateChatGptQuotaIdentity,
  recordChatGptQuotaSnapshot,
  recordChatGptRateLimited,
} from "../budget.js";
import {
  BrowserOAuthError,
  BrowserOAuthManager,
  createBrowserOAuthCredentialStore,
  createBrowserOAuthTokenSession,
} from "./auth.js";
import {
  createChatGptOAuthProvider,
  createChatGptProviderSession,
  registerChatGptOAuthProviderIfEnabled,
  type ChatGptOAuthActivationResult,
  type ChatGptOAuthProvider,
} from "./index.js";
import {
  ChatGptKeychainStore,
  ChatGptTokenSession,
  createChatGptOAuthRefresher,
} from "./keychain.js";
import {
  chatGptProviderCatalogue,
  discoverChatGptAccountModels,
} from "./models.js";
import { pollChatGptQuota } from "./quota.js";
import {
  installChatGptOAuthRouteRuntime,
  type ChatGptOAuthRouteRuntime,
} from "../../server/chatgpt-oauth-routes.js";
import { goldenCanarySuppressionAllowed } from "../../evals/provider-golden-rail.js";

export const CHATGPT_FEATURE_FLAG_KEY = "ai.chatgpt.enabled";
export const CHATGPT_CATALOGUE_CREDENTIAL_REVISION_KEY =
  "ai.model_catalog.chatgpt-oauth.credential_revision";

export interface ProductionChatGptRuntime {
  readonly auth: BrowserOAuthManager;
  readonly session: ChatGptTokenSession;
  readonly provider: ChatGptOAuthProvider;
  readonly activation: ChatGptOAuthActivationResult;
  shutdown(): Promise<void>;
}

export interface ChatGptRuntimeHandle {
  shutdown(): Promise<void>;
}

/** Honest route surface when Keychain/runtime construction is unavailable. */
export function installUnavailableChatGptRuntime(): ChatGptRuntimeHandle {
  installChatGptOAuthRouteRuntime({
    status: () => ({
      authState: { status: "unavailable", error: "ChatGPT authentication is unavailable" },
      plan: null,
      quota: { state: "unknown", resetAt: null },
      tokenExpiresAt: null,
      canary: { status: "unknown", checkedAt: null, error: null },
    }),
    start: async () => { throw new BrowserOAuthError("PROVIDER_UNAVAILABLE", "authentication unavailable"); },
    snapshot: () => ({ loginId: null, status: "idle", expiresAt: null, error: null }),
    cancel: async () => false,
    logout: async () => { throw new BrowserOAuthError("PROVIDER_UNAVAILABLE", "authentication unavailable"); },
  });
  return {
    async shutdown() { installChatGptOAuthRouteRuntime(null); },
  };
}

export interface ProductionChatGptRuntimeDependencies {
  fetch?: typeof fetch;
  appVersion: string;
  enabled?: () => boolean;
  activeProvider?: typeof getActiveProvider;
  register?: (provider: ProviderV2) => void;
  store?: ChatGptKeychainStore;
  session?: ChatGptTokenSession;
  catalogue?: () => ProviderModelCatalogue;
  checkQuota?: () => void;
  authManager?: BrowserOAuthManager;
  catalogueStore?: ProviderCatalogueStore;
  /** Accepted only inside the P6-F ChatGPT golden rail. */
  suppressCompatibilityCanary?: boolean;
}

function cachedCatalogue(store?: ProviderCatalogueStore): ProviderModelCatalogue {
  return chatGptProviderCatalogue({
    // Account discovery transport is intentionally not guessed here. The
    // shared catalogue service returns only the provider-scoped last-known
    // good entry; an absent entry stays honestly unavailable.
    discover: () => { throw new Error("discovery unavailable"); },
    store,
  });
}

function tokenExpiry(session: ChatGptTokenSession): string | null {
  try {
    const expiresAt = session.current().expiresAtMs;
    return expiresAt === undefined ? null : new Date(expiresAt).toISOString();
  } catch {
    return null;
  }
}

function quotaResetIso(value: number | string | undefined): string | null {
  if (value === undefined) return null;
  const millis = typeof value === "number" ? (value < 1_000_000_000_000 ? value * 1_000 : value) : Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

/**
 * Build the home-bound production session even while the feature is off, so
 * Settings can show and clear auth truth. Registration remains strictly flag
 * gated; only an active ChatGPT selection runs the boot canary.
 */
export async function initializeProductionChatGptRuntime(
  dependencies: ProductionChatGptRuntimeDependencies,
): Promise<ProductionChatGptRuntime> {
  const fetchImpl = dependencies.fetch ?? fetch;
  if (dependencies.suppressCompatibilityCanary === true && !goldenCanarySuppressionAllowed()) {
    throw new Error("ChatGPT compatibility canary suppression is restricted to provider golden mode");
  }
  const enabled = (dependencies.enabled ?? (() => appStateGet(CHATGPT_FEATURE_FLAG_KEY) === "1"))();
  const readActiveProvider = dependencies.activeProvider ?? getActiveProvider;
  const activeProvider = readActiveProvider();
  const store = dependencies.store ?? new ChatGptKeychainStore();
  const session = dependencies.session ?? await ChatGptTokenSession.open(
    store,
    createChatGptOAuthRefresher({
      fetch: fetchImpl,
      userAgent: `SuperTwinV13/${dependencies.appVersion}`,
    }),
  );
  // The shell is the sole browser owner: it opens the returned auth_url. This
  // explicit no-op satisfies BrowserOAuthManager's injected launcher without
  // causing a second system-browser navigation in the worker.
  const auth = dependencies.authManager ?? new BrowserOAuthManager({
    openBrowser: async () => undefined,
    browserOwner: "caller",
    credentialStore: createBrowserOAuthCredentialStore(session),
    tokenSession: createBrowserOAuthTokenSession(),
    fetch: fetchImpl,
  });
  const providerSession = createChatGptProviderSession(session);
  const catalogueStore = dependencies.catalogueStore ?? {
    get: appStateGet,
    set: appStateSet,
  };
  let discoveredCatalogue: ProviderModelCatalogue | null = null;
  let catalogueCredentialRevision: string | null = null;
  let catalogueFlight: Promise<void> | null = null;
  let successfulCredentialRevision: string | null = null;
  let lifecycleGeneration = 0;
  let catalogueAbort = new AbortController();
  let shuttingDown = false;
  let lifecyclePaused = false;
  let quotaIdentity: string | null = null;
  let quotaCredentialRevision: string | null = null;
  let quotaFlight: Promise<void> | null = null;
  const pollQuota = async (signal?: AbortSignal): Promise<void> => {
    const generation = lifecycleGeneration;
    let revision: string;
    try { revision = providerSession.credentialRevision(); } catch { return; }
    const result = await pollChatGptQuota({
      session: providerSession, fetch: fetchImpl,
      userAgent: `SuperTwinV13/${dependencies.appVersion}`, signal,
    });
    // The network result is untrusted stale state until the exact lifecycle
    // ticket and credential pair are revalidated. This check precedes every
    // persistent and in-memory quota mutation below.
    if (shuttingDown || lifecyclePaused || generation !== lifecycleGeneration ||
        session.authState().status !== "ready") return;
    try { if (providerSession.credentialRevision() !== revision) return; } catch { return; }
    invalidateChatGptQuotaIdentity(result.identity);
    quotaIdentity = result.identity;
    quotaCredentialRevision = revision;
    recordChatGptQuotaSnapshot({
      identity: result.identity,
      windows: [
        { kind: "primary", usedPercent: result.snapshot.primary.usedPercent,
          resetAt: quotaResetIso(result.snapshot.primary.resetAt) },
        ...(result.snapshot.secondary ? [{ kind: "secondary" as const,
          usedPercent: result.snapshot.secondary.usedPercent,
          resetAt: quotaResetIso(result.snapshot.secondary.resetAt) }] : []),
      ],
    });
  };
  const scheduleQuotaPoll = (expectedRevision?: string): void => {
    if (quotaFlight || shuttingDown || lifecyclePaused || !enabled || session.authState().status !== "ready") return;
    try { if (expectedRevision !== undefined && providerSession.credentialRevision() !== expectedRevision) return; }
    catch { return; }
    const signal = catalogueAbort.signal;
    quotaFlight = pollQuota(signal).catch(() => undefined).finally(() => { quotaFlight = null; });
  };
  const invalidateCatalogue = (): void => {
    discoveredCatalogue = null;
    catalogueCredentialRevision = null;
    catalogueStore.set(providerCatalogueCacheKey("chatgpt-oauth"), "");
    catalogueStore.set(CHATGPT_CATALOGUE_CREDENTIAL_REVISION_KEY, "");
  };
  if (enabled && !dependencies.catalogue && session.authState().status === "ready") {
    try {
      const credentialRevision = providerSession.credentialRevision();
      if (catalogueStore.get(CHATGPT_CATALOGUE_CREDENTIAL_REVISION_KEY) !== credentialRevision) {
        invalidateCatalogue();
      }
      const payload = await discoverChatGptAccountModels({
        session: providerSession,
        fetch: fetchImpl,
        userAgent: `SuperTwinV13/${dependencies.appVersion}`,
      });
      discoveredCatalogue = chatGptProviderCatalogue({
        discover: () => payload,
        store: catalogueStore,
      });
      catalogueCredentialRevision = credentialRevision;
      successfulCredentialRevision = credentialRevision;
      catalogueStore.set(CHATGPT_CATALOGUE_CREDENTIAL_REVISION_KEY, credentialRevision);
    } catch {
      // Same-provider last-known-good cache only; never Claude or a hardcoded list.
    }
  }
  if (enabled && session.authState().status === "ready") {
    await pollQuota().catch(() => undefined);
  }
  const catalogue = dependencies.catalogue ??
    (() => discoveredCatalogue ?? cachedCatalogue(catalogueStore));
  const provider = createChatGptOAuthProvider({
    session: providerSession,
    catalogue,
    checkQuota: dependencies.checkQuota ?? (() => assertProviderQuotaAvailable("chatgpt-oauth")),
    onRateLimited: (retryMs, revision) => {
      if (shuttingDown || lifecyclePaused || !quotaIdentity || quotaCredentialRevision !== revision ||
          session.authState().status !== "ready") return;
      try { if (providerSession.credentialRevision() !== revision) return; } catch { return; }
      recordChatGptRateLimited(quotaIdentity, retryMs);
    },
    onResponseSettled: scheduleQuotaPoll,
    fetch: fetchImpl,
    appVersion: dependencies.appVersion,
    suppressCompatibilityCanary: dependencies.suppressCompatibilityCanary === true,
  });
  let activation: ChatGptOAuthActivationResult = { registered: false, canary: "skipped" };
  let canaryCheckedAt: string | null = null;
  const defaultModel = (): string => catalogue().models.find((model) => model.isDefault && !model.hidden)?.id ?? "";
  if (enabled) {
    const canaryModelId = defaultModel();
    activation = canaryModelId
      ? await registerChatGptOAuthProviderIfEnabled({
          enabled, activeProviderId: activeProvider, provider, canaryModelId,
          register: dependencies.register ?? registerV2,
        })
      : (() => {
          (dependencies.register ?? registerV2)(provider);
          return { registered: true, canary: activeProvider === "chatgpt-oauth" ? "degraded" : "skipped" } as const;
        })();
    if (activeProvider === "chatgpt-oauth") canaryCheckedAt = new Date().toISOString();
  }

  const generationIsCurrent = (generation: number, revision: string): boolean => {
    if (shuttingDown || generation !== lifecycleGeneration || session.authState().status !== "ready") return false;
    try { return providerSession.credentialRevision() === revision; } catch { return false; }
  };
  const resetCanary = (): void => {
    activation = { registered: enabled, canary: "skipped" };
    canaryCheckedAt = null;
  };
  const refreshForCredential = (): Promise<void> => {
    if (shuttingDown || lifecyclePaused || !enabled || dependencies.catalogue || session.authState().status !== "ready") return Promise.resolve();
    let revision: string;
    try {
      revision = providerSession.credentialRevision();
    } catch {
      lifecycleGeneration += 1;
      catalogueAbort.abort();
      invalidateCatalogue();
      return Promise.resolve();
    }
    if (revision === catalogueCredentialRevision && discoveredCatalogue) {
      if (readActiveProvider() !== "chatgpt-oauth" || activation.canary === "ready" ||
          activation.canary === "degraded") return Promise.resolve();
      const modelId = discoveredCatalogue.models.find((model) => model.isDefault && !model.hidden)?.id;
      if (!modelId) return Promise.resolve();
      const generation = lifecycleGeneration;
      return provider.checkCanary(modelId, true).then((ready) => {
        if (!generationIsCurrent(generation, revision)) return;
        activation = { registered: true, canary: ready ? "ready" : "degraded" };
        canaryCheckedAt = new Date().toISOString();
      }).catch(() => {
        if (!generationIsCurrent(generation, revision)) return;
        activation = { registered: true, canary: "degraded" };
        canaryCheckedAt = new Date().toISOString();
      });
    }
    const cachedRevision = catalogueStore.get(CHATGPT_CATALOGUE_CREDENTIAL_REVISION_KEY);
    if (cachedRevision !== revision) {
      invalidateCatalogue();
      resetCanary();
    }
    if (catalogueFlight) return catalogueFlight.then(refreshForCredential);
    if (revision === successfulCredentialRevision) return Promise.resolve();
    lifecycleGeneration += 1;
    const generation = lifecycleGeneration;
    catalogueAbort.abort();
    catalogueAbort = new AbortController();
    const signal = catalogueAbort.signal;
    resetCanary();
    let flight!: Promise<void>;
    flight = (async () => {
      const payload = await discoverChatGptAccountModels({
        session: providerSession,
        fetch: fetchImpl,
        userAgent: `SuperTwinV13/${dependencies.appVersion}`,
        signal,
      });
      await pollQuota(signal).catch(() => undefined);
      if (!generationIsCurrent(generation, revision)) return;
      discoveredCatalogue = chatGptProviderCatalogue({ discover: () => payload, store: catalogueStore });
      catalogueCredentialRevision = revision;
      catalogueStore.set(CHATGPT_CATALOGUE_CREDENTIAL_REVISION_KEY, revision);
      if (readActiveProvider() === "chatgpt-oauth") {
        const modelId = discoveredCatalogue.models.find((model) => model.isDefault && !model.hidden)?.id;
        const ready = modelId ? await provider.checkCanary(modelId, true).catch(() => false) : false;
        if (!generationIsCurrent(generation, revision)) return;
        activation = { registered: true, canary: ready ? "ready" : "degraded" };
        canaryCheckedAt = new Date().toISOString();
      }
      if (generationIsCurrent(generation, revision)) successfulCredentialRevision = revision;
    })().catch(() => {
      if (generationIsCurrent(generation, revision)) {
        if (readActiveProvider() === "chatgpt-oauth") {
          activation = { registered: true, canary: "degraded" };
          canaryCheckedAt = new Date().toISOString();
        }
      }
    }).finally(() => { if (catalogueFlight === flight) catalogueFlight = null; });
    catalogueFlight = flight;
    return flight.then(() => {
      if (shuttingDown || lifecyclePaused || session.authState().status !== "ready") return;
      try {
        if (providerSession.credentialRevision() !== revision) return refreshForCredential();
      } catch { /* signed out while the request completed */ }
    });
  };

  let loginReadiness: { loginId: string; pending: boolean; promise: Promise<void> } | null = null;

  const routeRuntime: ChatGptOAuthRouteRuntime = {
    retryCatalogue: refreshForCredential,
    status: () => {
      const authState: ProviderAuthState = session.authState();
      const quota = chatGptQuotaStatus();
      return {
        authState,
        plan: null,
        quota: { state: quota.state, resetAt: quota.resetAt },
        tokenExpiresAt: tokenExpiry(session),
        canary: {
          status: activation.canary === "ready" ? "passed" : activation.canary === "degraded" ? "failed" : "unknown",
          checkedAt: canaryCheckedAt,
          error: activation.canary === "degraded"
            ? { code: "BACKEND_UNSUPPORTED", message: "ChatGPT compatibility check failed" }
            : null,
        },
      };
    },
    start: async () => {
      const started = await auth.start();
      const readiness = { loginId: started.loginId, pending: true, promise: Promise.resolve() };
      readiness.promise = auth.wait(started.loginId).then(() => {
        // A completed browser login is a new credential generation even when
        // the user selected the same account. Never carry its prior baseline
        // or transient 429 state into the new ceremony.
        invalidateChatGptQuotaIdentity();
        quotaIdentity = null;
        quotaCredentialRevision = null;
        return refreshForCredential();
      }).catch(() => undefined).finally(() => {
        readiness.pending = false;
      });
      loginReadiness = readiness;
      return started;
    },
    snapshot: () => {
      const snapshot = auth.snapshot();
      return loginReadiness?.pending && snapshot.loginId === loginReadiness.loginId && snapshot.status === "signed_in"
        ? { ...snapshot, status: "exchanging" }
        : snapshot;
    },
    cancel: (loginId) => auth.cancel(loginId),
    logout: async () => {
      lifecyclePaused = true;
      lifecycleGeneration += 1;
      catalogueAbort.abort();
      await auth.shutdown();
      provider.killAll();
      await catalogueFlight?.catch(() => undefined);
      await quotaFlight?.catch(() => undefined);
      await session.logout();
      invalidateChatGptQuotaIdentity();
      quotaIdentity = null;
      quotaCredentialRevision = null;
      successfulCredentialRevision = null;
      loginReadiness = null;
      invalidateCatalogue();
      resetCanary();
      lifecyclePaused = false;
    },
  };
  installChatGptOAuthRouteRuntime(routeRuntime);

  return {
    auth,
    session,
    provider,
    get activation() { return activation; },
    async shutdown() {
      shuttingDown = true;
      lifecycleGeneration += 1;
      catalogueAbort.abort();
      installChatGptOAuthRouteRuntime(null);
      await auth.shutdown();
      provider.killAll();
      await catalogueFlight?.catch(() => undefined);
      await quotaFlight?.catch(() => undefined);
      discoveredCatalogue = null;
      catalogueCredentialRevision = null;
      loginReadiness = null;
      session.close();
    },
  };
}
