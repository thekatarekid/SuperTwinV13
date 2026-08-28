// ===========================================================================
// Accessibility permission onboarding (build P2.1, spec §4.2.2).
//
// The screenwatch sidecar sits in `need_permission` until macOS Accessibility
// is granted; this banner polls /api/screen/status and, while permission is
// missing, offers the deep link into System Settings › Privacy & Security ›
// Accessibility. It renders nothing once capture is running (or when the
// worker / sidecar is unreachable — onboarding must never nag about a source
// that is not even installed).
// ===========================================================================

import { useEffect, useState } from "react";
import { fetchScreenStatus, type ScreenStatus } from "../lib/api";
import { openExternal } from "../lib/tauri";

const POLL_MS = 5_000;

export function AccessibilityOnboarding(): JSX.Element | null {
  const [status, setStatus] = useState<ScreenStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

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
  if (!needsPermission || dismissed) return null;

  return (
    <div
      role="status"
      className="glass-2"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        margin: "8px 16px 0",
        padding: "10px 14px",
        borderRadius: "12px",
        background: "var(--glass-2-bg)",
        backdropFilter: "var(--glass-blur)",
        border: "var(--glass-border)",
        fontSize: "var(--text-sm)",
      }}
    >
      <span aria-hidden="true">🖥</span>
      <span style={{ flex: 1 }}>
        <strong>Screen understanding is off.</strong> SuperTwin needs the
        macOS Accessibility permission to read what&apos;s on screen — grant
        it in System Settings, then capture starts on its own.
      </span>
      <button
        type="button"
        onClick={() => void openExternal(status.settingsUrl)}
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
  );
}
