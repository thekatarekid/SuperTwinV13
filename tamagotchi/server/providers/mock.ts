import type { Selection } from "../../shared/options.ts";
import type { ImageProvider } from "./types.ts";

// Offline stand-in used when no API key is configured (and by every test).
// Draws a flat chibi hero whose face sits where the real prompt asks the model
// to put it, so the whole cut-out → rig → puppet pipeline can be exercised
// without spending anything.

const PALETTES: Record<string, [string, string]> = {
  crimson: ["#d62839", "#f6c945"],
  ocean: ["#1f5fbf", "#c9d3dc"],
  jungle: ["#1f9d55", "#b6e34a"],
  violet: ["#7b3fe4", "#ff4fa3"],
  midnight: ["#2a2b33", "#ffe14d"],
};

const EMBLEMS: Record<string, string> = {
  lightning: "M500 640 L540 640 L515 690 L550 690 L490 760 L505 705 L475 705 Z",
  fire: "M512 630 C560 680 550 740 512 760 C474 740 464 690 500 660 C505 690 520 690 512 630 Z",
  ice: "M512 635 L512 755 M460 665 L564 725 M460 725 L564 665",
  nature: "M470 740 C470 670 530 640 560 640 C560 700 520 745 470 740 Z M470 740 L530 680",
  cosmic: "M512 635 L527 678 L572 680 L536 707 L549 750 L512 725 L475 750 L488 707 L452 680 L497 678 Z",
};

export function mockMascotSvg(sel: Selection): string {
  const [main, accent] = PALETTES[sel.palette[0]] ?? PALETTES.crimson;
  const acc = new Set(sel.accessories);
  const emblem = EMBLEMS[sel.power[0]] ?? EMBLEMS.lightning;
  const skin = "#f2c6a0";
  const hair = "#3b2a20";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" fill="#ffffff"/>
  ${acc.has("cape") ? `<path d="M400 590 L624 590 L700 900 L324 900 Z" fill="${accent}" stroke="#222" stroke-width="8"/>` : ""}
  <rect x="440" y="840" width="56" height="70" rx="20" fill="${accent}" stroke="#222" stroke-width="8"/>
  <rect x="528" y="840" width="56" height="70" rx="20" fill="${accent}" stroke="#222" stroke-width="8"/>
  <path d="M390 610 Q512 560 634 610 L650 850 L374 850 Z" fill="${main}" stroke="#222" stroke-width="8"/>
  <rect x="318" y="625" width="56" height="150" rx="28" fill="${main}" stroke="#222" stroke-width="8" transform="rotate(22 346 625)"/>
  <rect x="650" y="625" width="56" height="150" rx="28" fill="${main}" stroke="#222" stroke-width="8" transform="rotate(-22 678 625)"/>
  <rect x="385" y="800" width="254" height="30" fill="${accent}" stroke="#222" stroke-width="6"/>
  <path d="${emblem}" fill="${accent}" stroke="#222" stroke-width="6" stroke-linejoin="round"/>
  ${acc.has("headphones") ? `<path d="M420 575 Q512 640 604 575" fill="none" stroke="#222" stroke-width="22"/>` : ""}
  <circle cx="512" cy="370" r="200" fill="${skin}" stroke="#222" stroke-width="8"/>
  <path d="M318 330 Q330 160 512 150 Q694 160 706 330 Q640 250 512 245 Q384 250 318 330 Z" fill="${hair}" stroke="#222" stroke-width="8"/>
  ${acc.has("goggles") ? `<g fill="#9fd8ff" stroke="#222" stroke-width="8"><circle cx="455" cy="235" r="34"/><circle cx="569" cy="235" r="34"/></g>` : ""}
  ${acc.has("crown") ? `<path d="M560 170 L575 110 L605 150 L630 100 L645 165 Z" fill="#f6c945" stroke="#222" stroke-width="6"/>` : ""}
  ${acc.has("mask") ? `<path d="M380 350 Q512 320 644 350 Q650 405 580 410 Q512 380 444 410 Q374 405 380 350 Z" fill="${main}" stroke="#222" stroke-width="6"/>` : ""}
  <ellipse cx="440" cy="375" rx="26" ry="34" fill="#222"/>
  <ellipse cx="584" cy="375" rx="26" ry="34" fill="#222"/>
  <circle cx="448" cy="362" r="9" fill="#fff"/>
  <circle cx="592" cy="362" r="9" fill="#fff"/>
  <ellipse cx="410" cy="430" rx="26" ry="14" fill="#f59a9a" opacity="0.6"/>
  <ellipse cx="614" cy="430" rx="26" ry="14" fill="#f59a9a" opacity="0.6"/>
  <path d="M482 455 Q512 480 542 455" fill="none" stroke="#222" stroke-width="8" stroke-linecap="round"/>
</svg>`;
}

export function mockProvider(): ImageProvider {
  return {
    id: "mock",
    label: "Demo mode (no API key)",
    model: "mock",
    billable: false,
    async generate({ selection }) {
      // Feel like a real generation so loading states get exercised.
      await new Promise((r) => setTimeout(r, 900));
      return { image: Buffer.from(mockMascotSvg(selection)), mime: "image/svg+xml" };
    },
  };
}
