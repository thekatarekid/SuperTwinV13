// WhatsApp onboarding flow (docs/PHASE1_CONTRACT §6).
//
// Rendered by the Inbox tab when the connection is not yet paired-and-imported.
// Advances: QR (scan) → range picker → backfill progress → (dismiss into Inbox).
// State is owned by the passed-in useWhatsapp hook value; this is presentation.

import { QRCodeSVG } from "qrcode.react";
import {
  RANGES,
  RANGE_LABELS,
  DEFAULT_IMPORT_RANGE,
  type Range,
  type SourceError,
  type SourceState,
} from "../lib/worker-client";
import type { OnboardingStep } from "../lib/useWhatsapp";
import { useState } from "react";

interface OnboardingProps {
  step: OnboardingStep;
  state: SourceState;
  qr: string | null;
  lastError: SourceError | null;
  /**
   * R3.3: true during the brief unlink→QR transition right after a
   * "Re-sync from scratch" re-link. Shows a friendly "Re-linking… scan the QR"
   * state (and suppresses transient errors) instead of an empty/scary flash.
   */
  relinking?: boolean;
  onPair(): void;
  onImport(range: Range): void;
}

const STATE_TEXT: Record<SourceState, string> = {
  starting: "Starting…",
  need_pairing: "Waiting for you to scan the code",
  pairing: "Pairing…",
  connected: "Connected",
  syncing: "Syncing…",
  online: "Online",
  reconnecting: "Reconnecting…",
  logged_out: "Logged out",
  error: "Connection error",
};

export function WhatsappOnboarding({
  step,
  state,
  qr,
  lastError,
  relinking = false,
  onPair,
  onImport,
}: OnboardingProps) {
  return (
    <section className="wa-onboard" aria-label="WhatsApp setup">
      <div className="wa-onboard__inner">
        <header className="wa-onboard__hero">
          <h1 className="wa-onboard__heading">
            Bring your WhatsApp home
            <span className="wa-onboard__tag" aria-hidden="true">
              Setup
            </span>
          </h1>
        </header>
        <div className="wa-onboard__card">
        <Steps step={step} />

        {/* R3.3: during the relink transition suppress the (transient) error
            banner — the daemon is restarting; a scary error flash is wrong. */}
        {lastError && !relinking && (
          <div className="wa-onboard__error" role="alert">
            <strong>{lastError.code}:</strong> {lastError.message}
          </div>
        )}

        {step === "loading" && (
          <div className="wa-onboard__body wa-onboard__body--center">
            <div className="wa-spinner" aria-hidden="true" />
            <p className="wa-onboard__hint">Connecting to WhatsApp…</p>
          </div>
        )}

        {step === "qr" && (
          <QrStep qr={qr} state={state} relinking={relinking} onPair={onPair} />
        )}

        {step === "range" && <RangeStep onImport={onImport} />}

        {/* R5.1: there is NO "importing" onboarding step. Once the user starts
            the import we go straight to the Inbox, which shows a non-blocking
            progress banner instead of a full-screen modal. */}
        </div>
      </div>
    </section>
  );
}

function Steps({ step }: { step: OnboardingStep }) {
  // A 3-dot progress indicator. The final "Import" dot is a visual milestone
  // only — there's no blocking "importing" onboarding step anymore (R5.1); the
  // import runs in the Inbox behind a non-blocking banner.
  const order = ["qr", "range", "import"] as const;
  const labels: Record<string, string> = {
    qr: "Pair",
    range: "Choose history",
    import: "Import",
  };
  // "range" highlights the 2nd dot; "loading"/"qr" the 1st; anything past the
  // picker (i.e. importing/done, which render outside onboarding) the 3rd.
  const activeIdx = step === "qr" || step === "loading" ? 0 : step === "range" ? 1 : 2;
  return (
    <ol className="wa-steps" aria-label="Setup progress">
      {order.map((s, i) => (
        <li
          key={s}
          className={
            "wa-steps__item" +
            (i === activeIdx ? " wa-steps__item--active" : "") +
            (i < activeIdx ? " wa-steps__item--done" : "")
          }
        >
          <span className="wa-steps__dot">{i < activeIdx ? "✓" : i + 1}</span>
          <span className="wa-steps__label">{labels[s]}</span>
        </li>
      ))}
    </ol>
  );
}

function QrStep({
  qr,
  state,
  relinking,
  onPair,
}: {
  qr: string | null;
  state: SourceState;
  relinking?: boolean;
  onPair(): void;
}) {
  // Pairing is auto-started by useWhatsapp on mount (bug 1), so the QR appears
  // without a manual click. This button just re-triggers pairing to fetch a
  // fresh code (also used as a manual recovery if the code times out).
  return (
    <div className="wa-onboard__body">
      <h2 className="wa-onboard__title">
        {relinking ? "Re-linking WhatsApp" : "Link WhatsApp"}
      </h2>
      <p className="wa-onboard__hint">
        {relinking ? (
          <>Re-linking… scan the QR code to finish and re-import your chats.</>
        ) : (
          <>
            Open WhatsApp on your phone → <strong>Settings</strong> →{" "}
            <strong>Linked Devices</strong> → <strong>Link a Device</strong>,
            then scan this code.
          </>
        )}
      </p>

      {/* Solid white, padded, rounded frame so the QR is crisp + scannable in
          dark mode (bug 1: no white-on-white, real fg/bg contrast). */}
      <div className="wa-qr">
        {qr ? (
          <QRCodeSVG
            value={qr}
            size={240}
            marginSize={2}
            level="M"
            bgColor="#ffffff"
            fgColor="#000000"
            role="img"
            aria-label="WhatsApp pairing QR code"
          />
        ) : (
          <div className="wa-qr__placeholder">
            <div className="wa-spinner" aria-hidden="true" />
            <span className="wa-qr__waiting">
              {relinking
                ? "Re-linking… preparing a fresh QR code"
                : "Generating a pairing code…"}
            </span>
          </div>
        )}
      </div>

      <div className="wa-qr__actions">
        <button
          type="button"
          className="wa-btn wa-btn--ghost"
          onClick={onPair}
        >
          Refresh QR code
        </button>
      </div>

      <p className="wa-onboard__status" aria-live="polite">
        <span className={`wa-dot wa-dot--${dotVariant(state)}`} />
        {qr
          ? "Waiting for scan…"
          : relinking
            ? "Re-linking… scan the QR code"
            : STATE_TEXT[state]}
      </p>
    </div>
  );
}

function RangeStep({ onImport }: { onImport(range: Range): void }) {
  const [range, setRange] = useState<Range>(DEFAULT_IMPORT_RANGE);
  return (
    <div className="wa-onboard__body">
      <h2 className="wa-onboard__title">How much history?</h2>
      <p className="wa-onboard__hint">
        Choose how far back to import. You can always extend the range later.
      </p>

      <div className="wa-ranges" role="radiogroup" aria-label="Import range">
        {RANGES.map((r) => (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={range === r}
            className={
              "wa-range" + (range === r ? " wa-range--selected" : "")
            }
            onClick={() => setRange(r)}
          >
            {RANGE_LABELS[r]}
          </button>
        ))}
      </div>

      <button
        type="button"
        className="wa-btn wa-btn--primary"
        onClick={() => onImport(range)}
      >
        Import {RANGE_LABELS[range].toLowerCase()}
      </button>
    </div>
  );
}

function dotVariant(state: SourceState): string {
  if (state === "online" || state === "connected") return "online";
  if (state === "error" || state === "logged_out") return "error";
  return "busy";
}
