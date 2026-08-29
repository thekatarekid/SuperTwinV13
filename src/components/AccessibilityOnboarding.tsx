// ===========================================================================
// Accessibility permission onboarding (build P2.1, spec §4.2.2).
//
// The screenwatch sidecar sits in `need_permission` until macOS Accessibility
// is granted; this banner polls /api/screen/status and, while permission is
// missing, offers the deep link into System Settings › Privacy & Security ›
// Accessibility. It renders nothing once capture is running (or when the
// worker / sidecar is unreachable — onboarding must never nag about a source
// that is not even installed).
//
// "Open System Settings" must never fail silently: openExternal() rejects when
// the OS could not be reached, and we render the deep link plus the manual
// click-path inline so the user can still finish the grant by hand.
// ===========================================================================

import { useEffect, useState } from "react";
import { fetchScreenStatus, type ScreenStatus } from "../lib/api";
import { openExternal } from "../lib/tauri";

const POLL_MS = 5_000;

/** Where to click if the deep link cannot be opened for us. */
const MANUAL_PATH =
  "System Settings › Privacy & Security › Accessibility → switch on SuperTwinV13";

type CopyState = "idle" | "copied" | "failed";

export function AccessibilityOnboarding(): JSX.Element | null {
  const [status, setStatus] = useState<ScreenStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<CopyState>("idle");

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function poll(): Promise<void> {
      try {
        const s = await fetchScreenStatus();
        if (alive) setStatus(s);
      } catch {
        if (alive) setStatus(null); // worker unreachable — stay silent
      }
      if (alive) timer = setTimeout(() => void poll(), POLL_MS);
    }
    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const needsPermission =
    !!status && status.running && status.state === "need_permission";

  // Permission granted (or capture stopped): drop the stale error and re-arm
  // the dismiss, so a later revocation shows the banner again.
  useEffect(() => {
    if (status && status.state !== "need_permission") {
      setDismissed(false);
      setOpenError(null);
      setCopyState("idle");
    }
  }, [status]);

  if (!needsPermission || dismissed) return null;

  const settingsUrl = status.settingsUrl;

  async function handleOpen(): Promise<void> {
    setOpenError(null);
    setCopyState("idle");
    try {
      await openExternal(settingsUrl);
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleCopy(): Promise<void> {
    const clipboard =
      typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard?.writeText) {
      setCopyState("failed");
      return;
    }
    try {
      await clipboard.writeText(settingsUrl);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <div
      role="status"
      className="glass-2"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        margin: "8px 16px 0",
        padding: "10px 14px",
        borderRadius: "12px",
        background: "var(--glass-2-bg)",
        backdropFilter: "var(--glass-blur)",
        border: "var(--glass-border)",
        fontSize: "var(--text-sm)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        <span aria-hidden="true">🖥</span>
        <span style={{ flex: 1 }}>
          <strong>Screen understanding is off.</strong> SuperTwin needs the
          macOS Accessibility permission to read what&apos;s on screen — grant
          it in System Settings, then capture starts on its own.
        </span>
        <button
          type="button"
          onClick={() => void handleOpen()}
          style={{
            background: "var(--accent)",
            color: "var(--accent-ink)",
            border: "none",
            borderRadius: "8px",
            padding: "6px 12px",
            cursor: "pointer",
            fontSize: "var(--text-sm)",
          }}
        >
          Open System Settings
        </button>
        <button
          type="button"
          aria-label="dismiss"
          onClick={() => setDismissed(true)}
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            fontSize: "var(--text-md)",
            opacity: 0.6,
          }}
        >
          ✕
        </button>
      </div>

      {openError && (
        <div
          role="alert"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            padding: "8px 10px",
            borderRadius: "8px",
            border: "var(--glass-border)",
            fontSize: "var(--text-xs)",
          }}
        >
          <span>
            <strong>Couldn&apos;t open System Settings.</strong> Open it
            yourself: {MANUAL_PATH}.
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <code
              data-testid="accessibility-settings-url"
              style={{
                flex: 1,
                overflowWrap: "anywhere",
                userSelect: "all",
                opacity: 0.85,
              }}
            >
              {settingsUrl}
            </code>
            <button
              type="button"
              onClick={() => void handleCopy()}
              style={{
                background: "transparent",
                border: "var(--glass-border)",
                borderRadius: "6px",
                padding: "3px 8px",
                cursor: "pointer",
                fontSize: "inherit",
                whiteSpace: "nowrap",
              }}
            >
              {copyState === "copied"
                ? "Copied"
                : copyState === "failed"
                  ? "Select it above"
                  : "Copy link"}
            </button>
          </span>
          <span style={{ opacity: 0.6 }}>{openError}</span>
        </div>
      )}
    </div>
  );
}
