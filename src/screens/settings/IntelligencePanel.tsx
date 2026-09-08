// ===========================================================================
// Settings › Intelligence — which model runs each V13 step, how hard it
// thinks, and which encoder retrieval is built on.
//
// WHAT WAS BROKEN (defects 6 and 5b). The per-step picker offered three
// strings — haiku / sonnet / opus. None of them says which version will run,
// none of them carries a price, and there was no way to reach the dozen other
// models the local CLI can actually run. There was no reasoning control at
// all. And the encoder list underneath was four lines of inert text: sizes,
// no buttons, no way to fetch the model it called "recommended".
//
// WHAT IT IS NOW. The model list is DISCOVERED from the CLI's own catalogue
// (worker/src/providers/claude-local/discovery.ts) — versioned ids, per-
// million prices, and the reasoning levels each model genuinely accepts — with
// a curated list as the fallback and a line saying which of the two you are
// looking at. Beside each picker sits a second one for the reasoning level,
// built from the SELECTED model's own levels and disabled outright for a model
// that has none. The encoder list is a real list with Download, Delete, live
// progress and a size-on-disk readout.
//
// What was already right is kept: the per-step recommendation, the on/off
// toggle, the observed 7-day cost, and the eval gate on every change.
//
// V6 P1 S5.6 makes that last line REAL. "A model change runs the golden set
// first" used to be a sentence at the bottom of the pane; the change applied
// the moment you picked it. Now the change is a PROPOSAL: the worker runs the
// step's golden categories with the candidate in force and applies it only on
// a green compare. A red one leaves the old model where it was and names the
// categories that regressed. This pane shows which of the three things is
// happening — running, applied, blocked — and never claims a run it did not
// make: a build with no eval harness beside it says "skipped", plainly.
//
// The run button spends money, so it exists only where the harness does: the
// worker answers 409 when nothing is installed, and the button says why
// instead of failing on click.
// ===========================================================================

import { useCallback, useEffect, useRef, useState } from "react";

import { LoadFallback, useLoad } from "../../components/LoadState";
import {
  activateEmbeddingModel,
  cancelEmbeddingModelDownload,
  deleteEmbeddingModel,
  describeWorkerError,
  downloadEmbeddingModel,
  fetchEmbeddingModels,
  fetchChatGptLoginStatus,
  fetchChatGptProviderStatus,
  fetchSettingsIntelligence,
  cancelChatGptLogin,
  logoutChatGpt,
  runGoldenSet,
  saveIntelligenceProvider,
  saveIntelligenceStep,
  startChatGptLogin,
  type ChatGptLoginStart,
  type ChatGptLoginStatus,
  type ChatGptProviderStatus,
  type EmbeddingRegistry,
  type GoldenState,
  type IntelligenceSettings,
  type ModelOptionRow,
} from "../../lib/api";
import { openExternal } from "../../lib/tauri";
import { ModelList, type ModelRowView } from "./ModelList";
import { rowStyle } from "./shared";

/** How often the encoder list re-reads itself while a fetch is in flight. */
const PROGRESS_POLL_MS = 1000;
const LOGIN_POLL_MS = 750;

const CHATGPT_CONSENT =
  "SuperTwin will send selected WhatsApp messages, browser text, screen captures, and derived context to OpenAI using your personal ChatGPT/Codex subscription. This is consumer-service traffic, not API business data. OpenAI may retain or use content according to your account’s data controls. SuperTwin cannot guarantee no training, Temporary Chat treatment, or deletion. Confirm you have permission to share this data. You can sign out and stop future sends at any time.";

/** One line for each verdict the golden gate can be sitting on. */
function goldenLine(g: GoldenState): string {
  const what = g.step ? `${g.step}${g.candidate?.model ? ` → ${g.candidate.model}` : ""}${g.candidate?.thinking ? ` (thinking: ${g.candidate.thinking})` : ""}` : "the shipped configuration";
  const cats = g.categories ? g.categories.join(", ") : "the whole set";
  switch (g.status) {
    case "running":
      return `running ${cats} on ${what} — the change is NOT in force yet`;
    case "passed":
      return g.step ? `${cats} green — ${what} applied` : `${cats} green`;
    case "blocked":
      return `blocked: ${g.regressed.join(", ") || "a category"} below baseline — ${what} was NOT applied`;
    case "error":
      return `could not run: ${g.error ?? "unknown"} — nothing was applied`;
    case "skipped":
      return `not run — ${g.summary ?? "no golden runner in this build"}`;
    default:
      return "no golden run yet";
  }
}

/** "$1.00 in / $5.00 out per Mtok" — the number that decides a picker choice. */
function priceOf(m: ModelOptionRow): string {
  if (m.input_per_mtok === null || m.output_per_mtok === null) return "price unlisted";
  return `$${m.input_per_mtok}/M in · $${m.output_per_mtok}/M out`;
}

/**
 * The picker rows. The worker serves `models`; `options` is the 13.4.1 shape
 * and is only read when talking to a worker that predates the fix, so the two
 * halves of an in-place upgrade never render an empty dropdown.
 */
function modelRows(s: IntelligenceSettings): ModelOptionRow[] {
  if (s.catalogue?.models) {
    return s.catalogue.models
      .filter((model) => !model.hidden)
      .map((model) => ({
        id: model.id,
        label: model.displayName,
        family: model.id,
        alias: false,
        resolves_to: null,
        input_per_mtok: null,
        output_per_mtok: null,
        thinking_levels: model.reasoningValues,
        default_thinking: model.defaultReasoning,
        effort: model.reasoningValues.length > 0,
        context_window: model.contextWindow,
      }));
  }
  if (s.models && s.models.length > 0) return s.models;
  return s.options.map((id) => ({
    id,
    label: id,
    family: id,
    alias: true,
    resolves_to: null,
    input_per_mtok: null,
    output_per_mtok: null,
    thinking_levels: [],
    default_thinking: null,
    effort: false,
    context_window: null,
  }));
}

function catalogueLine(s: IntelligenceSettings, count: number): string {
  if (s.catalogue) {
    const provider = s.provider.selected === "chatgpt-oauth" ? "ChatGPT" : "Claude";
    if (s.catalogue.mode === "cached") {
      return `${count} cached ${provider} models — live discovery is unavailable${s.catalogue.error ? ` (${s.catalogue.error})` : ""}`;
    }
    if (s.catalogue.mode === "fallback") {
      return `${count} fallback ${provider} models${s.catalogue.error ? ` — ${s.catalogue.error}` : ""}`;
    }
    return `${count} models available from ${provider}`;
  }
  const discovery = s.discovery;
  return discovery?.mode === "discovered"
    ? `${count} models read from the local Claude CLI · prices per million tokens`
    : discovery?.mode === "cached"
      ? `${count} models read from the Claude CLI earlier — could not re-read it now (${discovery.error ?? "unknown"})`
      : discovery
        ? `curated fallback list — could not read the CLI's catalogue (${discovery.error ?? "unknown"})`
        : "model list served by the worker";
}

function providerPrice(s: IntelligenceSettings, modelId: string): string {
  const neutral = s.catalogue?.models.find((model) => model.id === modelId);
  if (neutral?.billingLabel) return neutral.billingLabel;
  const legacy = modelRows(s).find((model) => model.id === modelId);
  return legacy ? priceOf(legacy) : "price unlisted";
}

export function IntelligencePanel(): JSX.Element {
  const [embed, setEmbed] = useState<EmbeddingRegistry | null>(null);
  const [embedError, setEmbedError] = useState<string | null>(null);
  const [goldenNote, setGoldenNote] = useState<string | null>(null);
  const [providerBusy, setProviderBusy] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [chatGptStatus, setChatGptStatus] = useState<ChatGptProviderStatus | null>(null);
  const [chatGptStatusLoading, setChatGptStatusLoading] = useState(false);
  const [login, setLogin] = useState<ChatGptLoginStart | null>(null);
  const [loginStatus, setLoginStatus] = useState<ChatGptLoginStatus | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const goldenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const authGeneration = useRef(0);
  const statusTicket = useRef(0);
  const mutationTicket = useRef(0);

  // The step table gates the pane; the encoder registry is a section inside it
  // and carries its own failure line, so one being down never hides the other
  // (W3 — no read may end in a spinner that outlives it).
  const load = useLoad<IntelligenceSettings>(fetchSettingsIntelligence);
  const s = load.data;
  const setS = load.setData;
  const attempt = load.attempt;

  useEffect(() => {
    // React development StrictMode intentionally mounts, cleans up, and mounts
    // again; restore the live marker on that second setup.
    mounted.current = true;
    return () => {
      mounted.current = false;
      authGeneration.current += 1;
      statusTicket.current += 1;
      mutationTicket.current += 1;
    };
  }, []);

  const isCurrentAuth = useCallback(
    (generation: number) => mounted.current && authGeneration.current === generation,
    [],
  );

  const refreshEmbed = useCallback(async () => {
    try {
      setEmbed(await fetchEmbeddingModels());
      setEmbedError(null);
    } catch (err) {
      setEmbed(null);
      setEmbedError(describeWorkerError(err));
    }
  }, []);

  useEffect(() => {
    void refreshEmbed();
  }, [refreshEmbed, attempt]);

  const selectedProvider = s?.provider?.selected ?? "claude-local";

  const refreshChatGptStatus = useCallback(async (generation = authGeneration.current) => {
    if (!isCurrentAuth(generation)) return;
    const ticket = ++statusTicket.current;
    const isLatest = () => isCurrentAuth(generation) && statusTicket.current === ticket;
    setChatGptStatusLoading(true);
    try {
      const next = await fetchChatGptProviderStatus();
      if (!isLatest()) return;
      setChatGptStatus(next);
      setProviderError(null);
    } catch (err) {
      if (!isLatest()) return;
      setProviderError(describeWorkerError(err));
    } finally {
      if (isLatest()) setChatGptStatusLoading(false);
    }
  }, [isCurrentAuth]);

  const refreshAuthIntelligence = useCallback(async (
    generation: number,
    ticket?: number,
  ) => {
    const isLatest = () =>
      isCurrentAuth(generation) &&
      (ticket === undefined || mutationTicket.current === ticket);
    try {
      const next = await fetchSettingsIntelligence();
      if (isLatest()) setS(next);
    } catch (err) {
      if (isLatest()) setProviderError(describeWorkerError(err));
    }
  }, [isCurrentAuth, setS]);

  const retryIntelligence = useCallback(async () => {
    const generation = authGeneration.current;
    const ticket = ++mutationTicket.current;
    const isLatest = () => isCurrentAuth(generation) && mutationTicket.current === ticket;
    setProviderBusy(true);
    try {
      await refreshAuthIntelligence(generation, ticket);
    } finally {
      if (isLatest()) setProviderBusy(false);
    }
  }, [isCurrentAuth, refreshAuthIntelligence]);

  const saveProviderStep = useCallback(async (patch: {
    step: string;
    model?: string;
    thinking?: string;
    enabled?: boolean;
  }) => {
    const generation = authGeneration.current;
    const ticket = ++mutationTicket.current;
    const isLatest = () => isCurrentAuth(generation) && mutationTicket.current === ticket;
    setProviderBusy(true);
    setProviderError(null);
    try {
      await saveIntelligenceStep(patch);
      if (isLatest()) await refreshAuthIntelligence(generation, ticket);
    } catch (err) {
      if (isLatest()) setProviderError(describeWorkerError(err));
    } finally {
      if (isLatest()) setProviderBusy(false);
    }
  }, [isCurrentAuth, refreshAuthIntelligence]);

  useEffect(() => {
    if (!s?.provider || selectedProvider !== "chatgpt-oauth") return;
    void refreshChatGptStatus(authGeneration.current);
  }, [refreshChatGptStatus, s?.provider, selectedProvider]);

  // The browser callback completes without user input in this window. Poll the
  // bounded, redacted attempt state and rebuild every picker when it signs in.
  useEffect(() => {
    if (!login) return;
    const generation = authGeneration.current;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const next = await fetchChatGptLoginStatus(login.login_id);
        if (stopped || !isCurrentAuth(generation)) return;
        setLoginStatus(next);
        if (next.status === "signed_in") {
          setLogin(null);
          await Promise.all([
            refreshAuthIntelligence(generation),
            refreshChatGptStatus(generation),
          ]);
          return;
        }
        if (["failed", "cancelled", "expired"].includes(next.status)) {
          setLogin(null);
          return;
        }
        timer = setTimeout(() => void poll(), LOGIN_POLL_MS);
      } catch (err) {
        if (!stopped && isCurrentAuth(generation)) {
          setProviderError(describeWorkerError(err));
          setLogin(null);
        }
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [isCurrentAuth, login, refreshAuthIntelligence, refreshChatGptStatus]);

  // A download is minutes of work reported by polling the registry, not by a
  // held-open request; without this the progress line would never move.
  useEffect(() => {
    const busy =
      embed?.models.some((m) => m.download?.status === "downloading") === true ||
      (embed?.swap != null && embed.swap.phase === "embedding");
    if (!busy) return;
    timer.current = setTimeout(() => void refreshEmbed(), PROGRESS_POLL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [embed, refreshEmbed]);

  // A golden run is minutes of model work. While one is in flight the pane
  // re-reads itself, so "running" becomes "applied" or "blocked" on its own
  // instead of leaving a stale banner the user has to guess about.
  useEffect(() => {
    if (s?.golden?.state.status !== "running") return;
    const generation = authGeneration.current;
    const ticket = mutationTicket.current;
    goldenTimer.current = setTimeout(
      () => void refreshAuthIntelligence(generation, ticket),
      PROGRESS_POLL_MS,
    );
    return () => {
      if (goldenTimer.current) clearTimeout(goldenTimer.current);
    };
  }, [refreshAuthIntelligence, s]);

  /** Run one registry action and adopt whatever it answers with, error included. */
  const act = useCallback(
    async (fn: (id: string) => Promise<EmbeddingRegistry>, id: string) => {
      try {
        const next = await fn(id);
        setEmbedError(next.error ?? null);
        if (next.models) setEmbed(next);
        else await refreshEmbed();
      } catch (err) {
        setEmbedError(describeWorkerError(err));
      }
    },
    [refreshEmbed],
  );

  if (!s) return <LoadFallback state={load} what="Intelligence settings" />;
  const golden = s.golden;
  const gate = golden?.state;
  const running = gate?.status === "running";
  const groups = [...new Set(s.steps.map((x) => x.group))];
  const models = modelRows(s);
  const byId = new Map(models.map((m) => [m.id, m]));
  const provider = s.provider ?? {
    selected: "claude-local" as const,
    options: [{ id: "claude-local" as const, label: "Claude — Claude subscription", auth_state: "ready" as const }],
  };
  const selectedOption = provider.options.find((option) => option.id === provider.selected);
  const authState =
    provider.selected === "chatgpt-oauth"
      ? (chatGptStatus?.auth_state ?? selectedOption?.auth_state ?? "signed_out")
      : (selectedOption?.auth_state ?? "ready");
  const modelControlsDisabled =
    providerBusy ||
    login !== null ||
    (provider.selected === "chatgpt-oauth" && chatGptStatusLoading) ||
    authState !== "ready" ||
    models.length === 0;

  return (
    <div>
      <h2>Intelligence — model per step</h2>
      <label style={rowStyle}>
        <strong>AI provider</strong>
        <select
          aria-label="AI provider"
          value={provider.selected}
          disabled={providerBusy || login !== null}
          onChange={(event) => {
            const generation = ++authGeneration.current;
            const ticket = ++mutationTicket.current;
            const isLatest = () =>
              isCurrentAuth(generation) && mutationTicket.current === ticket;
            const nextProvider = event.target.value as "claude-local" | "chatgpt-oauth";
            const activeLogin = login;
            setProviderBusy(true);
            setProviderError(null);
            setChatGptStatus(null);
            setLogin(null);
            setLoginStatus(null);
            void (activeLogin
              ? cancelChatGptLogin(activeLogin.login_id).then(() => saveIntelligenceProvider(nextProvider))
              : saveIntelligenceProvider(nextProvider))
              .then((next) => {
                if (isLatest()) setS(next);
              })
              .catch((err: unknown) => {
                if (isLatest()) setProviderError(describeWorkerError(err));
              })
              .finally(() => {
                if (isLatest()) setProviderBusy(false);
              });
          }}
        >
          {provider.options.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>
      </label>
      {providerBusy ? <p className="meta" role="status">Updating intelligence settings…</p> : null}
      {providerError ? (
        <p className="meta" role="alert">
          {providerError}{" "}
          <button
            type="button"
            className="linklike"
            disabled={providerBusy || login !== null}
            onClick={() => void retryIntelligence()}
          >Retry</button>
        </p>
      ) : null}

      {provider.selected === "chatgpt-oauth" ? (
        <div className="golden-gate" style={{ margin: "8px 0", padding: "8px 0" }}>
          {chatGptStatusLoading && chatGptStatus === null ? (
            <p className="meta" role="status">Checking ChatGPT sign-in…</p>
          ) : authState === "ready" ? (
            <div style={rowStyle}>
              <span>
                <strong>ChatGPT signed in</strong>
                <span className="meta" style={{ display: "block" }}>
                  {[chatGptStatus?.plan, chatGptStatus?.quota.state].filter(Boolean).join(" · ") || "ChatGPT subscription"}
                </span>
              </span>
              <button
                type="button"
                className="btn"
                disabled={providerBusy}
                onClick={() => {
                  const generation = ++authGeneration.current;
                  setProviderBusy(true);
                  void logoutChatGpt()
                    .then(async () => {
                      if (!isCurrentAuth(generation)) return;
                      setChatGptStatus(null);
                      await refreshAuthIntelligence(generation);
                    })
                    .catch((err: unknown) => {
                      if (isCurrentAuth(generation)) setProviderError(describeWorkerError(err));
                    })
                    .finally(() => {
                      if (isCurrentAuth(generation)) setProviderBusy(false);
                    });
                }}
              >Sign out of ChatGPT</button>
            </div>
          ) : (
            <>
              <p>{CHATGPT_CONSENT}</p>
              <div style={rowStyle}>
                <span className="meta" role="status">
                  {loginStatus?.status === "exchanging"
                    ? "Finishing sign-in…"
                    : login
                      ? "Waiting for approval in your browser…"
                      : loginStatus?.status === "failed"
                        ? `Sign-in failed${loginStatus.error ? ` (${loginStatus.error})` : ""}. Try again.`
                        : loginStatus?.status === "cancelled"
                          ? "Sign-in cancelled."
                          : loginStatus?.status === "expired"
                            ? "The sign-in window expired. Try again."
                      : authState === "expired"
                        ? "Your ChatGPT sign-in expired. Sign in again to continue."
                        : authState === "unavailable"
                          ? "ChatGPT is unavailable in this build."
                          : authState === "degraded"
                            ? "ChatGPT needs attention before it can run models."
                            : "Sign in to use your ChatGPT subscription."}
                </span>
                {login ? (
                  <button
                    type="button"
                    className="btn"
                    disabled={providerBusy}
                    onClick={() => {
                      const id = login.login_id;
                      const generation = ++authGeneration.current;
                      setProviderBusy(true);
                      void cancelChatGptLogin(id)
                        .then(async (result) => {
                          if (!isCurrentAuth(generation)) return;
                          if (result.cancelled) {
                            setLogin(null);
                            setLoginStatus({ login_id: id, status: "cancelled", expires_at: null, error: null });
                            return;
                          }
                          const terminal = await fetchChatGptLoginStatus(id);
                          if (!isCurrentAuth(generation)) return;
                          setLoginStatus(terminal);
                          if (terminal.status === "signed_in") {
                            setLogin(null);
                            await Promise.all([
                              refreshAuthIntelligence(generation),
                              refreshChatGptStatus(generation),
                            ]);
                          } else if (["failed", "cancelled", "expired"].includes(terminal.status)) {
                            setLogin(null);
                          } else {
                            // Cancellation lost but the attempt is still live:
                            // restart polling under this newer generation.
                            setLogin((current) => current ? { ...current } : current);
                          }
                        })
                        .catch((err: unknown) => {
                          if (isCurrentAuth(generation)) {
                            setProviderError(describeWorkerError(err));
                            // Whether the cancel request failed or a
                            // `{cancelled:false}` truth-read failed, the
                            // listener may still complete. Keep polling it.
                            setLogin((current) => current ? { ...current } : current);
                          }
                        })
                        .finally(() => {
                          if (isCurrentAuth(generation)) setProviderBusy(false);
                        });
                    }}
                  >Cancel sign-in</button>
                ) : (
                  <button
                    type="button"
                    className="btn primary"
                    disabled={providerBusy || authState === "unavailable"}
                    onClick={() => {
                      const generation = ++authGeneration.current;
                      setProviderBusy(true);
                      setProviderError(null);
                      void startChatGptLogin()
                        .then(async (started) => {
                          if (!isCurrentAuth(generation)) {
                            await cancelChatGptLogin(started.login_id).catch(() => undefined);
                            return;
                          }
                          setLogin(started);
                          setLoginStatus({ login_id: started.login_id, status: "awaiting_browser", expires_at: started.expires_at, error: null });
                          try {
                            await openExternal(started.auth_url);
                          } catch (err) {
                            await cancelChatGptLogin(started.login_id).catch(() => undefined);
                            if (isCurrentAuth(generation)) setLogin(null);
                            throw err;
                          }
                        })
                        .catch((err: unknown) => {
                          if (isCurrentAuth(generation)) setProviderError(describeWorkerError(err));
                        })
                        .finally(() => {
                          if (isCurrentAuth(generation)) setProviderBusy(false);
                        });
                    }}
                  >Sign in with ChatGPT</button>
                )}
              </div>
              {authState === "unavailable" || authState === "degraded" ? (
                <button type="button" className="linklike" onClick={() => void refreshChatGptStatus()}>Retry ChatGPT status</button>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      <p className="meta">rec = advised, applied only by your choice</p>
      <p className="meta" role={s.catalogue?.mode === "cached" ? "status" : undefined}>
        {catalogueLine(s, models.length)}
        {s.catalogue?.mode === "cached" || models.length === 0 ? (
          <>{" "}<button
            type="button"
            className="linklike"
            disabled={providerBusy || login !== null}
            onClick={() => void retryIntelligence()}
          >Retry</button></>
        ) : null}
      </p>
      {models.length === 0 ? <p className="meta" role="alert">No models are available for this provider.</p> : null}
      <div className="golden-gate" style={{ margin: "8px 0" }}>
        <div style={rowStyle}>
          <strong>Golden set</strong>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="meta">
              {golden?.runner_installed
                ? (golden.runner_note ?? "installed")
                : "not installed in this build — changes apply and are recorded as skipped"}
            </span>
            <button
              className="btn"
              disabled={!golden?.runner_installed || running || providerBusy || login !== null}
              title={
                golden?.runner_installed
                  ? "Runs the whole golden set against the shipped configuration. This spends model calls."
                  : "No eval harness beside this worker, so there is nothing to run."
              }
              onClick={() => {
                const generation = authGeneration.current;
                const ticket = ++mutationTicket.current;
                const isLatest = () =>
                  isCurrentAuth(generation) && mutationTicket.current === ticket;
                setProviderBusy(true);
                setGoldenNote(null);
                void runGoldenSet({})
                  .then(async () => {
                    if (isLatest()) await refreshAuthIntelligence(generation, ticket);
                  })
                  .catch((err: unknown) => {
                    if (isLatest()) {
                      setGoldenNote(err instanceof Error ? err.message : String(err));
                    }
                  })
                  .finally(() => {
                    if (isLatest()) setProviderBusy(false);
                  });
              }}
            >
              {running ? "running…" : "Run golden set"}
            </button>
          </span>
        </div>
        {gate && (
          <p className="meta" role="status">
            {goldenLine(gate)}
          </p>
        )}
        {goldenNote && (
          <p className="meta" role="alert">
            {goldenNote}
          </p>
        )}
      </div>

      {groups.map((g) => (
        <div key={g}>
          <h3>{g}</h3>
          {s.steps
            .filter((x) => x.group === g)
            .map((x) => {
              const selectedModel = x.selected_model ?? x.selected;
              const picked = byId.get(selectedModel);
              // The levels the SELECTED model offers — the worker sends them
              // per step, and the catalogue row is the fallback for a worker
              // that does not yet.
              const levels = x.thinking_levels ?? picked?.thinking_levels ?? [];
              return (
                <div key={x.key} style={rowStyle}>
                  <span>{x.label}</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <select
                      aria-label={`${x.label} model`}
                      disabled={modelControlsDisabled || x.available === false}
                      value={selectedModel}
                      onChange={(e) => void saveProviderStep({ step: x.key, model: e.target.value })}
                    >
                      {models.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label} — {providerPrice(s, o.id)}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label={`${x.label} thinking`}
                      // A model with no reasoning dial gets a disabled control
                      // saying so, never a dropdown of choices that do nothing.
                      disabled={modelControlsDisabled || x.available === false || levels.length === 0}
                      value={levels.length === 0 ? "none" : (x.reasoning ?? x.thinking ?? "off")}
                      onChange={(e) =>
                        void saveProviderStep({
                          step: x.key,
                          thinking: e.target.value,
                        })
                      }
                    >
                      {levels.length === 0 ? (
                        <option value="none">no thinking levels</option>
                      ) : (
                        levels.map((l) => (
                          <option key={l} value={l}>
                            thinking: {l}
                          </option>
                        ))
                      )}
                    </select>
                    <span className="meta">rec: {x.recommended}</span>
                    <span className="meta" title="the golden categories a change to this step re-runs">
                      gates: {(x.eval_categories ?? []).join(", ") || "the whole set"}
                    </span>
                    {x.pending && (
                      <span className="meta" role="status">
                        waiting on the golden set…
                      </span>
                    )}
                    <span className="meta">
                      {x.calls_7d > 0 ? `$${x.cost_7d_usd.toFixed(2)} / 7d` : "—"}
                    </span>
                    <input
                      type="checkbox"
                      aria-label={`${x.label} enabled`}
                      disabled={providerBusy || login !== null || x.available === false}
                      checked={x.enabled}
                      onChange={(e) => void saveProviderStep({ step: x.key, enabled: e.target.checked })}
                    />
                  </span>
                </div>
              );
            })}
        </div>
      ))}

      <h3>Retrieval — embedding model</h3>
      {embed ? (
        <ModelList
          activeWord="active"
          error={embedError}
          rows={embed.models.map(
            (m): ModelRowView => ({
              id: m.id,
              label: `${m.label} · ${m.dim}d`,
              note: m.active ? `${m.indexed} indexed` : undefined,
              bytes: m.bytes,
              bytesOnDisk:
                m.files?.reduce((n, f) => n + (f.bytesOnDisk ?? 0), 0) ?? null,
              present: m.present,
              active: m.active,
              bundled: m.bundled,
              chips: [
                ...(m.active ? [{ text: "active", accent: true }] : []),
                ...(embed.default === m.id ? [{ text: "default" }] : []),
                ...(m.recommended && embed.default !== m.id ? [{ text: "recommended" }] : []),
                ...(m.bundled ? [{ text: "bundled" }] : []),
              ],
              download: m.download ?? null,
            }),
          )}
          onDownload={(id) => void act(downloadEmbeddingModel, id)}
          onCancel={(id) => void act(cancelEmbeddingModelDownload, id)}
          onDelete={(id) => void act(deleteEmbeddingModel, id)}
          onActivate={(id) => void act(activateEmbeddingModel, id)}
        />
      ) : (
        <p className="meta" role="alert">
          encoder registry unavailable{embedError ? ` — ${embedError}` : ""}{" "}
          <button type="button" className="linklike" onClick={() => void refreshEmbed()}>
            retry
          </button>
        </p>
      )}
      {embed?.swap && embed.swap.phase === "embedding" ? (
        <p className="meta" role="status">
          re-embedding onto {embed.swap.toModel ?? "the new model"} —{" "}
          {embed.swap.embedded ?? 0} of {embed.swap.total ?? 0}
        </p>
      ) : null}
      <p className="meta">swapping re-embeds in the background (§15 T3); the old index serves until the new one is complete</p>
      <p className="meta">
        ⚠ a model or reasoning change is a PROPOSAL: it runs the golden set first — the step&apos;s
        categories, with the candidate in force — and ships only on a green compare. A regression
        leaves the old choice exactly where it was and names what regressed (§18).
      </p>
    </div>
  );
}
