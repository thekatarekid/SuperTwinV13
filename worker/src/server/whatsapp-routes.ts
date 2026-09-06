// ===========================================================================
// Source + Inbox HTTP/SSE routes (docs/PHASE1_CONTRACT §6; arch §3.3 leak 4).
//
// Additive route module mounted by server/index.ts. Every handler returns true
// if it handled the request (so the caller can stop), false otherwise (so the
// caller falls through to the next router / 404). No Phase-0 route is touched.
//
// The control routes are namespaced by SOURCE. `/api/whatsapp/*` named one
// source in the URL of every client that would ever talk to any source; the
// path now carries the id instead, and the old spelling survives as an alias
// for exactly one release so the UI can be rewritten separately.
//
// Routes:
//   GET  /api/sources                             (registered sources)
//   GET  /api/sources/:source_id/status
//   GET  /api/sources/:source_id/stream  (SSE: status|qr|progress|paired|error)
//   POST /api/sources/:source_id/pair
//   GET  /api/sources/:source_id/counts   measured per-window counts (S1.5)
//   POST /api/sources/:source_id/confirm  { index, understand, card_text } (S1.5)
//   POST /api/sources/:source_id/import   { range }
//   POST /api/sources/:source_id/extend   { range }
//   POST /api/sources/:source_id/pause    { paused }
//   POST /api/sources/:source_id/logout
//   POST /api/sources/:source_id/relink
//   POST /api/sources/:source_id/reset
//   ALIAS (one release) /api/whatsapp/<action> == /api/sources/whatsapp/<action>
//   GET  /api/inbox/chats                ?limit&offset
//   GET  /api/inbox/chats/:id/messages   ?before&limit
//   GET  /api/inbox/search               ?q&limit
//   GET  /api/media/:eventId             (streamed file; traversal-guarded)
//   GET  /api/media/:eventId/thumb       (its stored media thumbnail)
//   GET  /api/media/:eventId/link-thumb  (its link preview's thumbnail)
//   GET  /api/media/:eventId/frameN      (the Nth frame sampled from a video)
// ===========================================================================

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { extname, join, resolve, sep } from "node:path";

import { registeredSources } from "../adapters/registry.js";
import { getSourceSupervisor } from "../adapters/supervisor.js";
import {
  confirmWhatsAppWindows,
  countsCaveats,
  describeWindows,
  WindowChoiceError,
} from "../adapters/whatsapp/connect.js";
import { mintApprovalToken } from "../approvals/tokens.js";
import { isRange, type RangeCounts, type StatusUpdate } from "../adapters/types.js";
import type { Ingestion } from "../ingest/index.js";
import {
  getEventById,
  getStreamMessages,
  listInboxChats,
  searchEvents,
  type EventMediaRow,
} from "../db/ingest.js";
import { deleteSourceData } from "../library/source-verbs.js";

/**
 * Which stored file of an event a media request wants. Every one of them is an
 * absolute path in the DB, so the payload only ever hands out these URLs.
 * `frame<N>` indexes into the video's sampled frames (v5 §2).
 */
type MediaFile = "file" | "thumb" | "link-thumb" | `frame${number}`;

/**
 * Media root. Precedence mirrors brainRoot() (SUPERTWIN_BRAIN_DIR →
 * SUPERTWIN_HOME/brain → ~/SuperTwinV13/brain) so db+brain+media stay in lockstep:
 *   1. SUPERTWIN_MEDIA_DIR — explicit override.
 *   2. SUPERTWIN_HOME/media — one home dir isolates all worker data.
 *   3. ~/SuperTwinV13/media    — real default.
 */
function mediaRoot(): string {
  const override = process.env.SUPERTWIN_MEDIA_DIR;
  if (override && override.trim().length > 0) return resolve(override);
  const home =
    process.env.SUPERTWIN_HOME && process.env.SUPERTWIN_HOME.trim().length
      ? process.env.SUPERTWIN_HOME
      : join(homedir(), "SuperTwinV13");
  return resolve(join(home, "media"));
}

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * One source control request: `/api/sources/:source_id/<action>`, or the
 * legacy `/api/whatsapp/<action>` spelling of the same thing.
 */
interface SourceRoute {
  sourceId: string;
  action: string;
  /** True when the caller used the old, source-named path. */
  alias: boolean;
}

const SOURCE_PATH = /^\/api\/sources\/([^/]+)\/([^/]+)$/;
/** @deprecated One release only (arch §3.3 leak 4). */
const LEGACY_WHATSAPP_PATH = /^\/api\/whatsapp\/([^/]+)$/;

export function matchSourceRoute(path: string): SourceRoute | null {
  const canonical = SOURCE_PATH.exec(path);
  if (canonical) {
    return { sourceId: decodeURIComponent(canonical[1]), action: canonical[2], alias: false };
  }
  const legacy = LEGACY_WHATSAPP_PATH.exec(path);
  if (legacy) return { sourceId: "whatsapp", action: legacy[1], alias: true };
  return null;
}

/**
 * Handle a source/Inbox/media request. Returns true if handled.
 * `ingestion` may be null if the adapter failed to init — status still works.
 */
export async function handleSourceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ingestion: Ingestion | null,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  // ---- GET /api/sources — what is registered (arch §2.2 note 5).
  if (method === "GET" && path === "/api/sources") {
    sendJson(
      res,
      200,
      registeredSources().map((entry) => ({
        source_id: entry.manifest.source_id,
        display_name: entry.manifest.display_name,
        actor_model: entry.manifest.actor_model,
        backfill_order: entry.manifest.capabilities.backfill_order,
        identities_emitted: entry.manifest.identities_emitted,
      })),
    );
    return true;
  }

  const route = matchSourceRoute(path);
  if (route) {
    // A control route names its source. Serving another source's request under
    // this adapter would be worse than a 404: it would silently pause, reset or
    // re-link the wrong one.
    if (ingestion && route.sourceId !== ingestion.sourceId && route.action !== "status") {
      sendJson(res, 404, { error: `unknown source ${JSON.stringify(route.sourceId)}` });
      return true;
    }

    switch (`${method} ${route.action}`) {
      // ---- GET status
      case "GET status":
        sendJson(res, 200, ingestion ? ingestion.getStatus() : offlineStatus());
        return true;

      // ---- GET stream (SSE)
      case "GET stream":
        handleStream(req, res, ingestion);
        return true;

      // ---- POST pair
      case "POST pair": {
        if (!ingestion) return notReady(res);
        // V6 S1.3: the daemon is no longer spawned at boot. Pairing is the one
        // pre-consent spawn (the QR flow needs it); the funnel drops every
        // frame until confirm grants the consent row (S1.2 / S1.5).
        await getSourceSupervisor()?.ensureWhatsAppDaemon();
        await ingestion.pair();
        sendJson(res, 200, { ok: true });
        return true;
      }

      // ---- GET counts (V6 S1.5, T4-7)
      // What each import window would deliver, MEASURED by the daemon over the
      // history it holds in its pre-confirm buffer — never a guess. Read-only:
      // installs no range, ingests nothing. `windows` are the card rows,
      // `caveats` the honest lines (bootstrap-only, how far back, held live).
      case "GET counts": {
        if (!ingestion) return notReady(res);
        let counts: RangeCounts;
        try {
          counts = await ingestion.countRange();
        } catch (err) {
          sendJson(res, 503, { error: "counts-unavailable", detail: (err as Error).message });
          return true;
        }
        const now = Date.now();
        sendJson(res, 200, {
          counts,
          windows: describeWindows(counts, now),
          caveats: countsCaveats(counts, now),
        });
        return true;
      }

      // ---- POST confirm { index, understand, card_text, counts? } (V6 S1.5)
      // The user's yes. Order matters: card text VERBATIM into `decisions`,
      // consent row granted pointing at it (T4-10 / CNS-09), THEN the daemon is
      // told to import the confirmed window — it drains the buffered history
      // filtered by it and releases the live messages it held, and the funnel,
      // now with a connected row, admits them. Nothing was ingested before this.
      //
      // CONTRACT (V6 P1 S6d L3): this route DISPATCHES the import, it does not
      // run it. `importRange` writes one `import` command to the daemon's stdin
      // and returns; the history that follows arrives over minutes, and
      // `importDone` stays false until the daemon's own `backfill_complete`. So
      // the 200 means "your yes is recorded and the import has started" —
      // `importing: true` with the window it started on — and the client
      // watches /status from there. A client must never wait on this response
      // for the import to be over: it never will be.
      case "POST confirm": {
        if (!ingestion) return notReady(res);
        const body = (await readJsonBody(req)) as
          | { index?: unknown; understand?: unknown; card_text?: unknown; counts?: unknown }
          | undefined;
        if (!body) {
          sendJson(res, 400, { error: "invalid JSON body" });
          return true;
        }
        let confirmed;
        try {
          confirmed = confirmWhatsAppWindows({
            index: body.index as never,
            understand: body.understand as never,
            cardText: typeof body.card_text === "string" ? body.card_text : "",
            counts: (body.counts as RangeCounts | undefined) ?? null,
          });
        } catch (err) {
          if (err instanceof WindowChoiceError) {
            sendJson(res, 400, { error: "invalid-windows", detail: err.message });
            return true;
          }
          throw err;
        }
        // The daemon is normally already up from pairing (ensureWhatsAppDaemon);
        // if it is not — a confirm after a worker restart — start it under the
        // consent that now exists.
        const supervisor = getSourceSupervisor();
        if (supervisor && !supervisor.isRunning("whatsapp")) {
          const outcome = await supervisor.start("whatsapp");
          if (!outcome.started && outcome.reason !== "already-running") {
            sendJson(res, 500, {
              error: "start-failed",
              reason: outcome.reason,
              detail: outcome.detail,
              consent: confirmed.consent,
              decision_id: confirmed.decisionId,
            });
            return true;
          }
        }
        await ingestion.importRange(confirmed.choice.index);
        sendJson(res, 200, {
          ok: true,
          consent: confirmed.consent,
          decision_id: confirmed.decisionId,
          floors: confirmed.floors,
          // The import has STARTED on this window — not finished. The client
          // moves to its import view on this, and watches /status for the rest.
          importing: true,
          range: confirmed.choice.index,
        });
        return true;
      }

      // ---- POST import { range }
      case "POST import": {
        if (!ingestion) return notReady(res);
        const body = (await readJsonBody(req)) as { range?: unknown } | undefined;
        if (!body || !isRange(body.range)) {
          sendJson(res, 400, { error: "valid range required" });
          return true;
        }
        await ingestion.importRange(body.range);
        sendJson(res, 200, { ok: true });
        return true;
      }

      // ---- POST extend { range }
      case "POST extend": {
        if (!ingestion) return notReady(res);
        const body = (await readJsonBody(req)) as { range?: unknown } | undefined;
        if (!body || !isRange(body.range)) {
          sendJson(res, 400, { error: "valid range required" });
          return true;
        }
        await ingestion.extend(body.range);
        sendJson(res, 200, { ok: true });
        return true;
      }

      // ---- POST send { to, text, approval_token }  (P0.6)
      // Double-gated send: the worker consumes the single-use token (invalid/
      // expired/used ⇒ 403, adapter never called) and the daemon refuses again
      // on its own. The outcome lands on the SSE stream as `send_result`.
      case "POST send": {
        if (!ingestion) return notReady(res);
        const body = (await readJsonBody(req)) as
          | { to?: unknown; text?: unknown; approval_token?: unknown }
          | undefined;
        const to = body && typeof body.to === "string" ? body.to.trim() : "";
        const text = body && typeof body.text === "string" ? body.text : "";
        const token =
          body && typeof body.approval_token === "string"
            ? body.approval_token
            : "";
        if (!to || !text || !token) {
          sendJson(res, 400, { error: "to, text and approval_token are required" });
          return true;
        }
        try {
          await ingestion.sendMessage({ to, text, approvalToken: token });
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 403, { error: (err as Error).message });
        }
        return true;
      }

      // ---- POST pause { paused }
      case "POST pause": {
        if (!ingestion) return notReady(res);
        const body = (await readJsonBody(req)) as { paused?: unknown } | undefined;
        const paused = Boolean(body && (body as { paused?: unknown }).paused);
        await ingestion.setPaused(paused);
        sendJson(res, 200, { ok: true, paused });
        return true;
      }

      // ---- POST logout
      // Standalone unlink. ingestion.logout() also clears the import flags (R3.2)
      // so onboarding restarts from the range picker once the daemon re-pairs.
      case "POST logout": {
        if (!ingestion) return notReady(res);
        await ingestion.logout();
        sendJson(res, 200, { ok: true });
        return true;
      }

      // ---- POST relink (Rev 3 §R3.2)
      // Full clean re-sync: (1) wipe this source's ingested data, (2) clear the
      // import flags, (3) send `logout` to the daemon (it clears its session +
      // exits 0; the adapter restarts it fresh into pairing).
      case "POST relink": {
        if (!ingestion) return notReady(res);
        await ingestion.relink();
        sendJson(res, 200, { ok: true });
        return true;
      }

      // ---- POST reset (Rev 2 §R2.3)
      // Wipe this source's ingested data + import flags. Keeps its session.
      case "POST reset": {
        // V6 S1.7 (T4-12): through the cascade, never a raw DELETE.
        const cleared = deleteSourceData(route.sourceId, { reason: "user reset the source" });
        // Also clear the adapter's in-memory import state so /status immediately
        // reports importDone:false (the DB flags were cleared inside the tx).
        ingestion?.clearImportState();
        // `channels` mirrors `streams` for one release — the UI still reads it.
        sendJson(res, 200, { ok: true, cleared: { ...cleared, channels: cleared.streams } });
        return true;
      }

      default:
        break;
    }
  }

  // ---- POST /api/approvals/mint { action, bind? } → { token, action, expires_at }
  // Mints one single-use signed approval token (P0.6). The approval modal calls
  // this at tap-time; it is also the programmatic mint surface (tests, scripts,
  // the mock e2e).
  //
  // V6 P1 S4.5: a SEND action must name what it is approving. An unbound send
  // token would authorize any recipient and any words, which is exactly the
  // gate this route exists to hold, so the mint is refused without a binding.
  if (method === "POST" && path === "/api/approvals/mint") {
    const body = (await readJsonBody(req)) as
      | { action?: unknown; bind?: unknown }
      | undefined;
    const action =
      body && typeof body.action === "string" && body.action.trim()
        ? body.action.trim()
        : "";
    if (!action) {
      sendJson(res, 400, { error: "action required" });
      return true;
    }
    const rawBind = body && typeof body.bind === "object" && body.bind !== null
      ? (body.bind as { to?: unknown; text?: unknown })
      : null;
    const bind =
      rawBind && typeof rawBind.to === "string" && typeof rawBind.text === "string"
        ? { to: rawBind.to, text: rawBind.text }
        : undefined;
    if (action.endsWith(".send") && !bind) {
      sendJson(res, 400, {
        error: "a send token must be bound: pass bind { to, text } — exactly what will be sent",
      });
      return true;
    }
    const minted = mintApprovalToken(action, bind ? { bind } : {});
    sendJson(res, 200, {
      token: minted.token,
      action: minted.action,
      expires_at: minted.expires_at,
    });
    return true;
  }

  // ---- GET /api/inbox/chats
  if (method === "GET" && path === "/api/inbox/chats") {
    const limit = numParam(url, "limit");
    const offset = numParam(url, "offset");
    const rows = listInboxChats({ limit, offset });
    sendJson(res, 200, rows);
    return true;
  }

  // ---- GET /api/inbox/chats/:id/messages
  const msgMatch = /^\/api\/inbox\/chats\/([^/]+)\/messages$/.exec(path);
  if (method === "GET" && msgMatch) {
    const streamId = decodeURIComponent(msgMatch[1]);
    const before = url.searchParams.get("before");
    const limit = numParam(url, "limit");
    const page = getStreamMessages({ streamId, before, limit });
    const rows = page.map((m) => ({
      id: m.id,
      ts: m.ts,
      kind: m.kind,
      text: m.text,
      fromMe: m.fromMe,
      actorName: m.actorName,
      // Media (media spec §4/§8): the metadata rides with the URL, so a revoked
      // message — whose media_path is gone but whose description row survives —
      // carries neither. The stored thumbnail is offered the same way as the
      // file itself: as a URL, because its path is absolute and a browser
      // cannot fetch one.
      ...(m.mediaPath
        ? {
            mediaUrl: mediaUrl(m.id),
            mediaMime: m.mediaMime,
            mediaFilename: m.mediaFilename,
            mediaSize: m.mediaSize,
            mediaSeconds: m.mediaSeconds,
            // The picture's own size, so the browser can reserve its box before
            // the bytes decode. Without it every image in a page grows from
            // nothing to its full height after paint, which is what makes a
            // scrolled-back thread jump (v7 §5).
            mediaWidth: m.mediaMeta?.width ?? null,
            mediaHeight: m.mediaMeta?.height ?? null,
            mediaDescription: m.mediaDescription,
            // The transcript (v5 §3) rides with the file for the same reason
            // the description does: it is derived from it, and a revoked row
            // has neither the file nor a claim on it.
            transcript: m.transcript,
            ...(m.mediaThumbPath
              ? { mediaThumbUrl: mediaUrl(m.id, "thumb") }
              : {}),
          }
        : {}),
      // Frames (v5 §2) do NOT ride with the file: the stills of a LINKED clip
      // (v7 §4) belong to a message that has none — the download is deleted and
      // they are all that is left of it. A revoke clears them, so a row that
      // still has any is a row still entitled to them.
      ...(m.mediaFrames && m.mediaFrames.length > 0
        ? {
            mediaFrames: m.mediaFrames.map((f, i) => ({
              url: mediaUrl(m.id, `frame${i}`),
              seconds: f.seconds,
            })),
          }
        : {}),
      // Edit/revoke tombstone the ORIGINAL row (media spec §5), so `kind` still
      // says image/message — these markers are the only way to render them.
      editedAt: m.editedAt,
      revokedAt: m.revokedAt,
      isForwarded: m.isForwarded,
      // Threading (§R5.3/§R5.4): net-current reaction chips + quoted-reply block.
      reactions: m.reactions,
      replyTo: m.replyTo,
      // Link preview (v3 §3). `scrapedText` is the page's own words, not the
      // sender's, and the UI labels it as such — it only exists once link
      // fetching has been switched on.
      link: m.link
        ? {
            url: m.link.url,
            title: m.link.title,
            description: m.link.description,
            previewType: m.link.previewType,
            scrapedText: m.link.scrapedText,
            ...(m.link.thumbPath
              ? { thumbUrl: mediaUrl(m.id, "link-thumb") }
              : {}),
          }
        : null,
    }));
    sendJson(res, 200, rows);
    return true;
  }

  // ---- GET /api/inbox/search
  if (method === "GET" && path === "/api/inbox/search") {
    const q = url.searchParams.get("q") ?? "";
    const limit = numParam(url, "limit");
    // `channelId`/`channelName` mirror the stream fields for one release, so the
    // UI keeps rendering hits while it is rewritten (arch §3.3 leak 6).
    const rows = searchEvents({ q, limit }).map((hit) => ({
      ...hit,
      channelId: hit.streamId,
      channelName: hit.streamName,
    }));
    sendJson(res, 200, rows);
    return true;
  }

  // ---- GET /api/media/:eventId[/thumb|/link-thumb|/frameN]
  // Event ids contain '/', so the payload percent-encodes them and the id is a
  // single segment here — which is what leaves the suffix free to name a file.
  const mediaMatch = /^\/api\/media\/([^/]+)(?:\/(thumb|link-thumb|frame\d+))?$/.exec(
    path,
  );
  if (method === "GET" && mediaMatch) {
    const file = (mediaMatch[2] as MediaFile | undefined) ?? "file";
    await handleMedia(res, decodeURIComponent(mediaMatch[1]), file);
    return true;
  }

  return false;
}

// ---- SSE stream -----------------------------------------------------------

function handleStream(
  req: IncomingMessage,
  res: ServerResponse,
  ingestion: Ingestion | null,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Immediately emit the current status as a `status` frame so late subscribers
  // catch up (e.g. reconnect mid-pairing).
  const initial: StatusUpdate = {
    type: "status",
    state: (ingestion ? ingestion.getStatus() : offlineStatus()).state,
  };
  writeSse(res, initial);

  if (!ingestion) {
    // No adapter — keep the stream open but idle (client can retry actions).
    req.on("close", () => res.end());
    return;
  }

  const unsub = ingestion.subscribeStatus((s) => writeSse(res, s));
  // Heartbeat so proxies/clients keep the connection alive.
  const beat = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* closed */
    }
  }, 25_000);
  beat.unref?.();

  req.on("close", () => {
    clearInterval(beat);
    unsub();
    res.end();
  });
}

function writeSse(res: ServerResponse, frame: StatusUpdate): void {
  try {
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  } catch {
    /* stream closed */
  }
}

// ---- Media streaming (traversal-guarded) ----------------------------------

/**
 * The stored path a request names, or null when there is nothing to serve.
 *
 * A revoke NULLs media_path but leaves media_thumb_path behind, so the full
 * file is what decides whether the thumbnail derived from it is still the
 * message's to hand out. link_thumb_path is cleared by that same revoke and
 * belongs to a row that has no media_path at all, so it stands on its own.
 */
function storedPath(ev: EventMediaRow, file: MediaFile): string | null {
  if (file === "link-thumb") return ev.linkThumbPath;
  // A frame is named by its position in the stored sequence, never by a path
  // off the wire — the index is the only thing a caller gets to choose. Asked
  // for ahead of media_path because the stills of a LINKED clip (v7 §4) outlive
  // the download they were taken from: the file is deleted, they are the only
  // record of it. A revoke clears them along with everything else, so there is
  // nothing here for the full file to withhold on their behalf.
  const frame = /^frame(\d+)$/.exec(file);
  if (frame) return ev.mediaFrames?.[Number(frame[1])]?.path ?? null;
  if (!ev.mediaPath) return null;
  if (file === "thumb") return ev.mediaThumbPath;
  return ev.mediaPath;
}

async function handleMedia(
  res: ServerResponse,
  eventId: string,
  file: MediaFile,
): Promise<void> {
  const ev = getEventById(eventId);
  const stored = ev ? storedPath(ev, file) : null;
  if (!stored) {
    sendJson(res, 404, { error: "media not found" });
    return;
  }

  // Resolve + confine to the media root (defence in depth against traversal).
  const root = mediaRoot();
  const abs = resolve(stored);
  if (abs !== root && !abs.startsWith(root + sep)) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }

  let size = 0;
  try {
    const st = await stat(abs);
    if (!st.isFile()) {
      sendJson(res, 404, { error: "media not found" });
      return;
    }
    size = st.size;
  } catch {
    sendJson(res, 404, { error: "media not found" });
    return;
  }

  const mime = MIME_BY_EXT[extname(abs).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": String(size),
    "Cache-Control": "private, max-age=3600",
  });
  const stream = createReadStream(abs);
  stream.on("error", () => {
    if (!res.writableEnded) res.end();
  });
  stream.pipe(res);
}

// ---- Helpers --------------------------------------------------------------

/** Where a caller fetches one of an event's stored files. */
function mediaUrl(eventId: string, file: MediaFile = "file"): string {
  const base = `/api/media/${encodeURIComponent(eventId)}`;
  return file === "file" ? base : `${base}/${file}`;
}

function offlineStatus() {
  return {
    state: "error" as const,
    paired: false,
    paused: false,
    lastError: { code: "NO_ADAPTER", message: "source adapter not initialized" },
  };
}

function notReady(res: ServerResponse): boolean {
  sendJson(res, 503, { error: "source adapter not initialized" });
  return true;
}

function numParam(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
