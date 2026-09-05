// ===========================================================================
// Capture routes — V6 P1 S1.7 (Build §4.2 [D]). The filter's lists, the
// private moment, forget-last-N, the per-source verbs with their previews,
// the outside-window review, and the one read the tray lives on.
//
//   GET  /api/capture/state                       real capture state (tray)
//   POST /api/capture/stop                        one-click stop: pause every
//                                                 admitted source
//   POST /api/capture/private-moment  {minutes?}  15 min unless told otherwise;
//                                    {end:true}   ends it
//   GET  /api/capture/lists                       {apps, sites, chats, senders}
//   POST /api/capture/lists           {apps?, sites?, chats?, senders?}
//   POST /api/capture/forget/preview  {minutes}   dry run → CascadePreview
//   POST /api/capture/forget          {minutes}   the cascade
//   POST /api/capture/sources/:s/pause | resume | disconnect
//   POST /api/capture/sources/:s/delete/preview   dry run → SourceDeletePreview
//   POST /api/capture/sources/:s/delete           revoke → stop → cascade
//   GET  /api/capture/sources/:s/outside-window   labelled episodes (CNS-08)
//   POST /api/capture/sources/:s/outside-window/preview
//   POST /api/capture/sources/:s/outside-window/delete
//
// Every write goes through library/source-verbs.ts and db/capture-filter.ts;
// this file parses and answers. Returns false for any path it does not claim.
// ===========================================================================

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  CAPTURE_LIST_KINDS,
  capturePauseState,
  endPrivateMoment,
  PRIVATE_MOMENT_MINUTES,
  readCaptureLists,
  setCaptureList,
  startPrivateMoment,
  type CaptureListKind,
} from "../db/capture-filter.js";
import { writeDecision } from "../db/decisions.js";
import {
  deleteOutsideWindow,
  deleteSource,
  disconnectSource,
  forgetLastMinutes,
  outsideWindowEpisodes,
  pauseSource,
  previewForget,
  previewOutsideWindowDelete,
  previewSourceDelete,
  resumeSource,
  sourceCaptureStates,
  stopAllCapture,
} from "../library/source-verbs.js";
import { SUPERVISED_SOURCES } from "../adapters/supervisor.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function minutesOf(body: Record<string, unknown>, fallback: number): number {
  const m = body.minutes;
  return typeof m === "number" && Number.isFinite(m) && m > 0 ? m : fallback;
}

/** The tray's one read: is anything actually being captured, and by whom. */
export function captureState(nowMs: number = Date.now()): Record<string, unknown> {
  const pause = capturePauseState(nowMs);
  const sources = sourceCaptureStates();
  const admitted = sources.filter((s) => s.capturing).map((s) => s.source);
  const recording = sources.filter((s) => s.capturing && s.running).map((s) => s.source);
  return {
    // True when at least one source is admitted at the funnel AND its adapter
    // is running AND no pause deadline is live — i.e. events can land now.
    capturing: !pause.paused && recording.length > 0,
    recording: pause.paused ? [] : recording,
    admitted,
    paused: pause.paused,
    private_until: pause.privateUntil,
    quick_pause_until: pause.quickPauseUntil,
    private_moment_minutes: PRIVATE_MOMENT_MINUTES,
    sources,
  };
}

function knownSource(s: string): boolean {
  return (SUPERVISED_SOURCES as readonly string[]).includes(s) || s === "wa";
}

export async function handleCaptureRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (!path.startsWith("/api/capture/")) return false;

  if (method === "GET" && path === "/api/capture/state") {
    sendJson(res, 200, captureState());
    return true;
  }

  if (method === "POST" && path === "/api/capture/stop") {
    const outcomes = await stopAllCapture("tray");
    sendJson(res, 200, { ok: true, paused: outcomes.map((o) => o.source), state: captureState() });
    return true;
  }

  if (method === "POST" && path === "/api/capture/private-moment") {
    const body = await readBody(req);
    const before = capturePauseState().privateUntil;
    if (body.end === true) {
      endPrivateMoment();
      writeDecision({
        pass: "user",
        targetKind: "capture",
        targetId: "private_moment",
        action: "private_moment_end",
        old: { until: before },
        new: { until: null },
      });
      sendJson(res, 200, { ok: true, private_until: null, state: captureState() });
      return true;
    }
    const until = startPrivateMoment(minutesOf(body, PRIVATE_MOMENT_MINUTES));
    writeDecision({
      pass: "user",
      targetKind: "capture",
      targetId: "private_moment",
      action: "private_moment",
      old: { until: before },
      new: { until },
      reason: "private moment — capture paused from the menu bar / hotkey",
    });
    sendJson(res, 200, { ok: true, private_until: until, state: captureState() });
    return true;
  }

  if (path === "/api/capture/lists") {
    if (method === "GET") {
      sendJson(res, 200, readCaptureLists());
      return true;
    }
    if (method === "POST") {
      const body = await readBody(req);
      for (const kind of CAPTURE_LIST_KINDS) {
        if (body[kind] !== undefined) {
          if (!Array.isArray(body[kind])) {
            sendJson(res, 400, { error: `${kind} must be an array of strings` });
            return true;
          }
          setCaptureList(kind as CaptureListKind, body[kind]);
        }
      }
      sendJson(res, 200, readCaptureLists());
      return true;
    }
  }

  if (method === "POST" && path === "/api/capture/forget/preview") {
    const body = await readBody(req);
    sendJson(res, 200, { preview: previewForget(minutesOf(body, 10)) });
    return true;
  }

  if (method === "POST" && path === "/api/capture/forget") {
    const body = await readBody(req);
    sendJson(res, 200, { report: forgetLastMinutes(minutesOf(body, 10)) });
    return true;
  }

  const m = /^\/api\/capture\/sources\/([^/]+)\/(pause|resume|disconnect|delete|outside-window)(?:\/(preview|delete))?$/.exec(
    path,
  );
  if (m) {
    const source = decodeURIComponent(m[1]!);
    const verb = m[2]!;
    const sub = m[3] ?? null;
    if (!knownSource(source)) {
      sendJson(res, 404, { error: `unknown source ${source}` });
      return true;
    }
    if (method === "POST" && verb === "pause" && !sub) {
      sendJson(res, 200, await pauseSource(source));
      return true;
    }
    if (method === "POST" && verb === "resume" && !sub) {
      sendJson(res, 200, await resumeSource(source));
      return true;
    }
    if (method === "POST" && verb === "disconnect" && !sub) {
      sendJson(res, 200, await disconnectSource(source));
      return true;
    }
    if (method === "POST" && verb === "delete" && sub === "preview") {
      sendJson(res, 200, { preview: previewSourceDelete(source) });
      return true;
    }
    if (method === "POST" && verb === "delete" && !sub) {
      sendJson(res, 200, await deleteSource(source));
      return true;
    }
    if (method === "GET" && verb === "outside-window" && !sub) {
      sendJson(res, 200, outsideWindowEpisodes(source));
      return true;
    }
    if (method === "POST" && verb === "outside-window" && sub === "preview") {
      sendJson(res, 200, { preview: previewOutsideWindowDelete(source) });
      return true;
    }
    if (method === "POST" && verb === "outside-window" && sub === "delete") {
      sendJson(res, 200, { report: deleteOutsideWindow(source) });
      return true;
    }
    sendJson(res, 405, { error: `${method} not allowed on ${path}` });
    return true;
  }

  return false;
}
