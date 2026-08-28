// ===========================================================================
// Generative result renderer — golden tests per result type (build P4.2,
// spec §14.5). One canonical payload per executor schema; assertions pin the
// composed text the kit renders so a schema-branch regression (or a model
// payload leaking styling decisions) fails loudly. Plus the two §14.5
// honesty guarantees: unknown types fall back to the document card, and
// missing fields render as absent — never as a crash.
// ===========================================================================

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ResultRenderer } from "./components/ResultRenderer";

afterEach(cleanup);

function renderResult(result_type: string, data: Record<string, unknown>): HTMLElement {
  render(<ResultRenderer result={{ result_type, data }} />);
  return screen.getByTestId("result-region");
}

describe("ResultRenderer golden payloads (one per executor schema)", () => {
  it("comparison_table: title, columns, rows, recommendation", () => {
    const region = renderResult("comparison_table", {
      title: "CCU-GOI fares",
      columns: ["flight", "dep", "fare"],
      rows: [
        ["IndiGo 6E-204", "07:00", "₹4,850"],
        ["Air India 671", "09:15", "₹5,200"],
      ],
      recommendation: "IndiGo 6E-204 — best fit",
    });
    expect(region.querySelectorAll("th")).toHaveLength(3);
    expect(region.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(region.textContent).toContain("CCU-GOI fares");
    expect(region.textContent).toContain("IndiGo 6E-204");
    expect(region.textContent).toContain("← IndiGo 6E-204 — best fit");
  });

  it("itinerary: legs render when — what, with notes", () => {
    const region = renderResult("itinerary", {
      title: "Goa day 1",
      legs: [
        { when: "07:00", what: "CCU→GOI 6E-204" },
        { when: "11:30", what: "cab to Anjuna" },
      ],
      notes: "web check-in opens 48h before",
    });
    expect(region.querySelectorAll("li")).toHaveLength(2);
    expect(region.textContent).toContain("07:00 — CCU→GOI 6E-204");
    expect(region.textContent).toContain("web check-in opens 48h before");
  });

  it("draft_preview: channel → recipient header, subject, quoted body", () => {
    const region = renderResult("draft_preview", {
      channel: "whatsapp",
      to: "Sameer",
      body: "haan bhej deta hoon kal tak",
    });
    expect(region.textContent).toContain("draft · whatsapp → Sameer");
    expect(region.querySelector("blockquote")?.textContent).toBe("haan bhej deta hoon kal tak");
  });

  it("approval_card: summary · amount, detail rows, cancellation policy", () => {
    const region = renderResult("approval_card", {
      summary: "Pay IndiGo",
      amount: "₹18,340",
      details: [
        { label: "passengers", value: "4" },
        { label: "dates", value: "18→21 Dec" },
      ],
      cancellation_policy: "free till Sep 15",
    });
    expect(region.textContent).toContain("Pay IndiGo");
    expect(region.textContent).toContain("₹18,340");
    expect(region.textContent).toContain("passengers: 4");
    expect(region.textContent).toContain("free till Sep 15");
  });

  it("research_brief: title, summary, findings, sources", () => {
    const region = renderResult("research_brief", {
      title: "Anjuna villas",
      summary: "6 compared, 3 fit ₹6k/night",
      findings: [{ point: "Villa Sol ₹5.4k ★4.8" }, { point: "Palm Grove has no pool" }],
      sources: ["airbnb.com", "booking.com"],
    });
    expect(region.querySelectorAll("li")).toHaveLength(2);
    expect(region.textContent).toContain("6 compared, 3 fit ₹6k/night");
    expect(region.textContent).toContain("sources: airbnb.com · booking.com");
  });

  it("checklist: state marks ✓ / ○ / ✕ per item", () => {
    const region = renderResult("checklist", {
      title: "Trip prep",
      items: [
        { label: "flights", state: "done" },
        { label: "villa", state: "open" },
        { label: "visa", state: "blocked" },
      ],
    });
    expect(region.textContent).toContain("✓ flights");
    expect(region.textContent).toContain("○ villa");
    expect(region.textContent).toContain("✕ visa");
  });

  it("receipt: performed summary, timestamp, reference", () => {
    const region = renderResult("receipt", {
      summary: "web check-in done",
      performed_at: "2026-08-28T07:00:00Z",
      reference: "PNR X9K2L",
    });
    expect(region.textContent).toContain("✓ web check-in done");
    expect(region.textContent).toContain("ref PNR X9K2L");
  });
});

describe("ResultRenderer honesty (spec §14.5)", () => {
  it("an unknown result_type falls back to the clean document card, never a blank", () => {
    const region = renderResult("weather_forecast", {
      title: "Goa in December",
      high: 32,
      tips: ["carry sunscreen", "book cabs early"],
    });
    const card = screen.getByTestId("document-card");
    expect(region.contains(card)).toBe(true);
    expect(card.textContent).toContain("Goa in December");
    expect(card.textContent).toContain("carry sunscreen · book cabs early");
  });

  it("missing fields render as absent, never as a crash", () => {
    const region = renderResult("comparison_table", {});
    expect(region.querySelectorAll("tbody tr")).toHaveLength(0);
    cleanup();
    const draft = renderResult("draft_preview", {});
    expect(draft.textContent).toContain("draft · message → ?");
  });
});
