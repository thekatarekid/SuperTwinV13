// ===========================================================================
// Settings › Capture & Privacy — the filter's four lists (apps · sites ·
// chats · senders, enforced at the funnel — V6 S1.7), per-domain page-text
// rules, the per-source VERBS (pause · resume · disconnect · delete with a
// preview, never one button — T4-11), the outside-window review (CNS-08),
// and the one line that is never a setting: incognito windows are always
// excluded (spec §14.9.2).
// ===========================================================================

import { useCallback, useEffect, useState } from "react";

import { LoadFallback, useLoad } from "../../components/LoadState";
import {
  deleteCaptureSource,
  deleteOutsideWindow,
  describeWorkerError,
  disconnectCaptureSource,
  fetchCaptureState,
  fetchOutsideWindow,
  fetchSettingsCapture,
  pauseCaptureSource,
  previewDeleteSource,
  resumeCaptureSource,
  saveSettingsCapture,
  type CaptureSettings,
  type CaptureSourceState,
  type CaptureState,
  type OutsideWindowReview,
  type SourceDeletePreview,
} from "../../lib/api";
import { SaveError } from "./shared";

const SOURCE_LABEL: Record<string, string> = {
  whatsapp: "WhatsApp",
  browser: "Browser",
  screen: "Screen",
};

function consentLine(s: CaptureSourceState): string {
  if (s.consent === null) return "not connected";
  if (s.consent === "connected") return s.running ? "capturing" : "connected · adapter not running";
  return s.consent;
}

function SourceRow(props: {
  state: CaptureSourceState;
  onChanged: () => void;
}): JSX.Element {
  const { state, onChanged } = props;
  const [preview, setPreview] = useState<SourceDeletePreview | null>(null);
  const [review, setReview] = useState<OutsideWindowReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const label = SOURCE_LABEL[state.source] ?? state.source;

  const run = async (fn: () => Promise<unknown>, done?: string): Promise<void> => {
    setBusy(true);
    try {
      await fn();
      if (done) setNote(done);
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const connected = state.consent === "connected";
  const pausedOrDisconnected = state.consent === "paused" || state.consent === "disconnected";

  return (
    <div className="capture-source" data-testid={`capture-source-${state.source}`}>
      <div className="panel-row">
        <span className="grow">
          <strong>{label}</strong> · {consentLine(state)}
        </span>
        {connected && (
          <button type="button" className="chip" disabled={busy} onClick={() => void run(() => pauseCaptureSource(state.source), "paused")}>
            pause
          </button>
        )}
        {pausedOrDisconnected && (
          <button type="button" className="chip" disabled={busy} onClick={() => void run(() => resumeCaptureSource(state.source), "resumed")}>
            resume
          </button>
        )}
        {(connected || state.consent === "paused") && (
          <button
            type="button"
            className="chip"
            disabled={busy}
            onClick={() => void run(() => disconnectCaptureSource(state.source), "disconnected — data kept")}
          >
            disconnect
          </button>
        )}
        {state.consent !== null && (
          <button
            type="button"
            className="chip danger"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const r = await previewDeleteSource(state.source);
                setPreview(r.preview);
              })
            }
          >
            delete…
          </button>
        )}
        {state.consent !== null && (
          <button
            type="button"
            className="chip"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setReview(await fetchOutsideWindow(state.source));
              })
            }
          >
            review window
          </button>
        )}
      </div>
      {preview && (
        <div className="capture-preview" data-testid={`delete-preview-${state.source}`}>
          <p>
            Delete {label}: {preview.events_deleted} events · {preview.episodes_deleted} episodes ·{" "}
            {preview.spaces_touched} spaces · {preview.tasks_deleted} tasks · {preview.claims_deleted} claims
            {preview.first_ts && preview.last_ts
              ? ` · ${preview.first_ts.slice(0, 10)} → ${preview.last_ts.slice(0, 10)}`
              : ""}
            . Consent is revoked first, then the adapter stops, then the data cascades. Not reversible.
          </p>
          <button
            type="button"
            className="chip danger"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const r = await deleteCaptureSource(state.source);
                setPreview(null);
                setNote(`deleted ${r.deleted.events} events, ${r.deleted.cascade.episodes_deleted} episodes`);
              })
            }
          >
            delete {label}
          </button>
          <button type="button" className="chip" disabled={busy} onClick={() => setPreview(null)}>
            keep
          </button>
        </div>
      )}
      {review && (
        <div className="capture-review" data-testid={`outside-window-${state.source}`}>
          {review.episodes.length === 0 ? (
            <p>
              Nothing understood before the current window
              {review.understand_from ? ` (${review.understand_from.slice(0, 10)})` : ""}.
            </p>
          ) : (
            <>
              <p>
                {review.episodes.length} episodes from before {review.understand_from?.slice(0, 10)} are still
                understood — labelled <em>outside window</em>. They stay unless you delete them.
              </p>
              <ul>
                {review.episodes.slice(0, 8).map((e) => (
                  <li key={e.id}>
                    {e.first_ts?.slice(0, 10)} · {e.summary ?? e.id} · {e.events} events
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="chip danger"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const r = await deleteOutsideWindow(state.source);
                    setReview(null);
                    setNote(`removed ${r.report.episodes} episodes (${r.report.events_deleted} events)`);
                  })
                }
              >
                delete these {review.episodes.length}
              </button>
            </>
          )}
          <button type="button" className="chip" disabled={busy} onClick={() => setReview(null)}>
            close
          </button>
        </div>
      )}
      {note && (
        <p className="meta" role="status">
          {note}{" "}
          <button type="button" className="linklike" onClick={() => setNote(null)}>
            ok
          </button>
        </p>
      )}
    </div>
  );
}

export function CapturePanel(): JSX.Element {
  const [state, setState] = useState<CaptureState | null>(null);
  const [stateError, setStateError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const gate = useLoad<CaptureSettings>(fetchSettingsCapture);
  const s = gate.data;
  const setS = gate.setData;
  const attempt = gate.attempt;

  const refreshState = useCallback(() => {
    void fetchCaptureState()
      .then((v) => {
        setState(v);
        setStateError(null);
      })
      .catch((err: unknown) => {
        setState(null);
        setStateError(describeWorkerError(err));
      });
  }, []);

  useEffect(() => {
    refreshState();
  }, [refreshState, attempt]);

  if (!s) return <LoadFallback state={gate} what="Capture & Privacy settings" />;
  const save = async (patch: Partial<CaptureSettings>): Promise<void> => {
    setSaveError(null);
    try {
      setS(await saveSettingsCapture(patch));
    } catch (err) {
      setSaveError(`that list was not saved — ${describeWorkerError(err)}`);
    }
  };
  const listEditor = (
    label: string,
    key: "app_blocklist" | "domain_blocklist" | "chat_blocklist" | "sender_blocklist" | "pagetext_rules",
    hint?: string,
  ): JSX.Element => (
    <div style={{ padding: "4px 0" }}>
      <div>{label}</div>
      {hint && <div className="meta">{hint}</div>}
      <textarea
        rows={2}
        style={{ width: "100%" }}
        aria-label={label}
        defaultValue={(s[key] ?? []).join("\n")}
        onBlur={(e) => void save({ [key]: e.target.value.split("\n").map((v) => v.trim()).filter(Boolean) })}
      />
    </div>
  );
  return (
    <div>
      <h2>Capture &amp; Privacy</h2>
      <SaveError error={saveError} onDismiss={() => setSaveError(null)} />

      <h3>Sources</h3>
      {state ? (
        <>
          <p className="meta" data-testid="capture-summary">
            {state.private_until
              ? `private moment until ${state.private_until.slice(11, 16)} UTC`
              : state.paused
                ? "capture paused"
                : state.recording.length > 0
                  ? `capturing: ${state.recording.join(", ")}`
                  : "nothing is being captured"}
          </p>
          {state.sources.map((src) => (
            <SourceRow key={src.source} state={src} onChanged={refreshState} />
          ))}
        </>
      ) : (
        <p className="empty" role="alert">
          source state unavailable{stateError ? ` — ${stateError}` : ""}{" "}
          <button type="button" className="linklike" onClick={refreshState}>
            retry
          </button>
        </p>
      )}

      <h3>Never captured (your lists)</h3>
      <p className="meta">
        Enforced where events enter the log — a listed app, site, chat or sender is not indexed, not understood, not
        searchable. One entry per line.
      </p>
      {listEditor("Apps (bundle id, app name, or a prefix like com.bank.)", "app_blocklist")}
      {listEditor("Sites (domain — covers its subdomains)", "domain_blocklist")}
      {listEditor("Chats (WhatsApp chat / group id)", "chat_blocklist")}
      {listEditor("Senders (contact id)", "sender_blocklist")}
      {listEditor("Page-text capture rules (per domain)", "pagetext_rules")}
      <p className="privacy-line">
        Always excluded, not a setting: incognito and private windows, password managers, secure text fields,
        WhatsApp status updates.
      </p>
    </div>
  );
}
