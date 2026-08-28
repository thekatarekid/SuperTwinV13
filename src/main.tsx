import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
