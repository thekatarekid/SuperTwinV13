// ===========================================================================
// [CODE] SRC — source quality executor (GoldenEvals V6 P1 §5.3; V6 P1 S1.4).
//
// Deterministic, zero model calls, zero DB. Each case drives the real product
// code the watcher and the packer use:
//
//   SRC-01  bridges/normalise.urlTextForm    params stripped, content kept
//   SRC-02  BrowserWatcher.visitEvents       payload.url byte-identical
//   SRC-10  adapters/browser/render          ×N collapse at render, rows kept
//
// SRC-03/04 (screen) and SRC-09 (WhatsApp reply structure, judge) belong to
// S1.6 and S1.5; until their executors register they report pending here so
// the category is never a fake pass or a fake fail.
// ===========================================================================

import { urlTextForm, urlTextParams } from "../../bridges/normalise.js";
import { collapseVisitRuns, isVisitRun, renderVisitRun } from "../../adapters/browser/render.js";
import { BrowserWatcher } from "../../adapters/browser/watcher.js";
import { MemorySink } from "../../adapters/browser/sink.js";
import type { RawVisit } from "../../adapters/browser/history-db.js";
import type { BrowserVisitPayload } from "../../adapters/browser/envelope.js";
import type { Executor, ExecutorResult, Violation } from "../runner.js";

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

// ---- SRC-01 ----------------------------------------------------------------

export function src01Code(inputs: unknown[]): ExecutorResult {
  const violations: Violation[] = [];
  const output: Array<{ url: string; text: string; params: string[]; keep: string[] }> = [];
  for (const raw of inputs) {
    const item = rec(raw);
    const url = typeof item.url === "string" ? item.url : "";
    const keep = Array.isArray(item.keep) ? item.keep.filter((k): k is string => typeof k === "string") : [];
    const text = urlTextForm(url);
    const params = urlTextParams(url);
    output.push({ url, text, params, keep });
    for (const k of keep) {
      if (!params.includes(k)) violations.push({ label: "content-param-stripped", note: `${k} missing from ${text}` });
    }
    for (const p of params) {
      if (!keep.includes(p)) violations.push({ label: "tracking-kept", note: `${p} survived in ${text}` });
    }
    const sorted = [...params].sort();
    if (params.join("&") !== sorted.join("&")) violations.push({ label: "survivors-unsorted", note: params.join(",") });
  }
  const before = inputs.reduce<number>((n, i) => n + (typeof rec(i).url === "string" ? (rec(i).url as string).length : 0), 0);
  const after = output.reduce((n, o) => n + o.text.length, 0);
  return {
    ok: violations.length === 0,
    output,
    violations,
    metrics: { url_bytes_before: before, url_bytes_after: after, url_text_tracking_bytes: Math.max(0, before - after) },
    notes: [`${inputs.length} URLs · ${before} → ${after} bytes in the text form`],
  };
}

// ---- SRC-02 ----------------------------------------------------------------

const NOW = Date.parse("2026-08-28T12:00:00.000Z");

function rawVisit(url: string, i: number): RawVisit {
  return {
    visitId: i + 1,
    url,
    title: `Page ${i + 1}`,
    tsMs: NOW - (10 - i) * 60_000,
    transition: "typed",
    typed: true,
    redirect: false,
    referrerVisitId: 0,
    visitCount: i + 1,
    dwellMs: 0,
    browser: "chrome",
  };
}

export function src02Code(inputs: unknown[]): ExecutorResult {
  const urls = inputs.map((i) => rec(i).url).filter((u): u is string => typeof u === "string");
  const watcher = new BrowserWatcher({ sink: new MemorySink(), profiles: [], sinceMs: 0, now: () => NOW });
  const events = watcher.visitEvents(urls.map(rawVisit), new Set());
  const violations: Violation[] = [];
  const output = events.map((e, i) => {
    const p = e.payload as BrowserVisitPayload;
    const identical = p.url === urls[i];
    if (!identical) violations.push({ label: "payload-url-rewritten", note: `${urls[i]} → ${p.url}` });
    return { url: urls[i], payload_url: p.url, text: e.text, identical, text_differs: !e.text.endsWith(urls[i] ?? "") };
  });
  return {
    ok: violations.length === 0 && events.length === urls.length,
    output,
    violations,
    metrics: { payload_url_byte_identical: violations.length === 0 ? 1 : 0, events: events.length },
  };
}

// ---- SRC-10 ----------------------------------------------------------------

interface VisitSpec {
  url: string;
  count: number;
  start: string;
  step_ms: number;
  transitions: string[];
  visit_count: number;
}

function specOf(raw: unknown): VisitSpec {
  const r = rec(raw);
  return {
    url: typeof r.url === "string" ? r.url : "",
    count: typeof r.count === "number" ? r.count : 1,
    start: typeof r.start === "string" ? r.start : "2026-08-28T13:58:00.000Z",
    step_ms: typeof r.step_ms === "number" ? r.step_ms : 0,
    transitions: Array.isArray(r.transitions) ? r.transitions.filter((t): t is string => typeof t === "string") : ["link"],
    visit_count: typeof r.visit_count === "number" ? r.visit_count : 1,
  };
}

export function src10Code(inputs: unknown[]): ExecutorResult {
  const events: Array<{ id: string; ts: string; kind: string; text: string; actor: string; payloadJson: string }> = [];
  for (const raw of inputs) {
    const spec = specOf(raw);
    const start = Date.parse(spec.start);
    for (let i = 0; i < spec.count; i++) {
      const ts = new Date(start + i * spec.step_ms).toISOString();
      events.push({
        id: `ev_${events.length + 1}`,
        ts,
        kind: "browser.visit",
        actor: "self",
        text: `Goibibo ${urlTextForm(spec.url)}`,
        payloadJson: JSON.stringify({
          url: spec.url,
          title: "Goibibo",
          transition: spec.transitions[Math.min(i, spec.transitions.length - 1)] ?? "link",
          visit_count: spec.visit_count,
          dwell_ms: 7,
          browser: "chrome",
        }),
      });
    }
  }
  const aliasOf = (e: { id: string }) => `e${events.findIndex((x) => x.id === e.id) + 1}`;
  const runs = collapseVisitRuns(events);
  const lines = runs.map((run) => (isVisitRun(run) ? renderVisitRun(run, aliasOf, "self") : run.map((e) => e.text).join("\n")));
  const survivors = runs.reduce((n, r) => n + r.length, 0);
  const violations: Violation[] = [];
  const firstSpec = specOf(inputs[0]);
  const runForFirst = runs.find((r) => JSON.parse(r[0]!.payloadJson).url === firstSpec.url) ?? [];
  const firstLine = lines[runs.indexOf(runForFirst)] ?? "";
  const sameUrlLines = lines.filter((l) => l.includes(firstSpec.url) || l.includes(urlTextForm(firstSpec.url)));
  if (sameUrlLines.length !== 1) violations.push({ label: "six-lines", note: `${sameUrlLines.length} lines for ${firstSpec.url}` });
  if (survivors !== events.length) violations.push({ label: "rows-deleted", note: `${survivors} of ${events.length} events survived` });
  if (/dwell/i.test(lines.join("\n"))) violations.push({ label: "dwell-rendered" });
  const okCount = firstLine.includes(`×${firstSpec.count}`);
  const okSpan = /\d{2}:\d{2}(–\d{2}:\d{2})?/.test(firstLine);
  const okTransition = firstSpec.transitions.every((t) => firstLine.includes(t));
  const okVisitCount = firstLine.includes(`${firstSpec.visit_count} visits`);
  return {
    ok: violations.length === 0 && okCount && okSpan && okTransition && okVisitCount && lines.length === runs.length,
    output: { lines, runs: runs.map((r) => r.map((e) => e.id)), events: events.length },
    violations,
    metrics: {
      duplicate_visit_collapse: okCount ? 1 : 0,
      packed_lines: lines.length,
      events: events.length,
      survivors,
    },
    notes: [firstLine],
  };
}

// ---- Executor ---------------------------------------------------------------

export const sourceQualityExecutor: Executor = ({ fixture }) => {
  switch (fixture.id) {
    case "SRC-01":
      return src01Code(fixture.input_events);
    case "SRC-02":
      return src02Code(fixture.input_events);
    case "SRC-10":
      return src10Code(fixture.input_events);
    default:
      return {
        output: null,
        pending: `${fixture.id} is measured by another lane's executor (SRC-03/04 screen → S1.6, SRC-09 WhatsApp → S1.5)`,
      };
  }
};
