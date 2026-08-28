// Minimal placeholder shell — the V11 tabs UI was pruned in P0.3.
// The V13 UI is rebuilt from scratch per spec §14 (design system first,
// screens after) starting in P1/P4. Until then this shell only proves the
// Vite build and the worker wiring: it shows the logo and the worker health.

import { useEffect, useState } from "react";
import { workerUrl } from "./lib/config";
import logo from "./assets/logo.png";

export function App(): JSX.Element {
  const [health, setHealth] = useState<string>("checking…");

  useEffect(() => {
    let cancelled = false;
    fetch(workerUrl("/api/health"))
      .then((res) => res.json())
      .then((body: { status?: string; version?: string }) => {
        if (cancelled) return;
        setHealth(`worker ${body.status ?? "?"} · v${body.version ?? "?"}`);
      })
      .catch(() => {
        if (!cancelled) setHealth("worker unreachable");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "1rem",
        fontFamily: "Figtree, system-ui, sans-serif",
      }}
    >
      <img src={logo} alt="SuperTwin" style={{ width: 96, height: 96 }} />
      <h1 style={{ fontFamily: "'Instrument Serif', serif", fontWeight: 400 }}>SuperTwinV13</h1>
      <p>{health}</p>
    </main>
  );
}
