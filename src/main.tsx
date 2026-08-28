import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { Panel } from "./panel/Panel";
import { Nudge } from "./panel/Nudge";
import { isTauri } from "./lib/tauri";
// Bundled fonts (self-contained offline app — no CDN).
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "@fontsource/figtree/400.css";
import "@fontsource/figtree/500.css";
import "@fontsource/figtree/600.css";
import "@fontsource/figtree/700.css";
// P1.7 design tokens + app chrome (hand-written, no framework).
import "./styles/tokens.css";
import "./styles/app.css";

// Inside Tauri the body stays transparent (vibrancy paints beneath it);
// in a plain browser app.css supplies the stand-in gradient.
if (isTauri()) document.body.classList.add("tauri");

// One Vite bundle, three windows (P2.3, spec §14.7): the main shell, the
// 360px menu-bar panel (#panel) and the transient nudge card (#nudge).
const hash = typeof window !== "undefined" ? window.location.hash : "";
const Root = hash === "#panel" ? Panel : hash === "#nudge" ? Nudge : App;
if (hash === "#panel" || hash === "#nudge") document.body.classList.add("aux-window");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
