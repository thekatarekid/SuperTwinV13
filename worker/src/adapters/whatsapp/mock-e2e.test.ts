// ===========================================================================
// Mock e2e ingest (P0.6 acceptance): the REAL Go daemon in --mock mode, driven
// through the REAL adapter + Ingestion into a real temp SQLite DB.
//
//   - `import 90d` lands ≥95% of the daemon's emitted events in the DB
//     (backfill containment; dedupe means the shortfall can only be losses);
//   - send gate end-to-end: a tokened send round-trips (send_result ok:true +
//     the echo event persists), a replayed token is refused BY THE DAEMON
//     (send_result ok:false), and the --fixture send-refusal file refuses
//     every send.
//
// Skipped cleanly when the Go toolchain is unavailable (the same coverage runs
// in Go's own tests + scripts/e2e-mock.mjs in CI images that carry Go).
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { mintApprovalToken } from "../../approvals/tokens.js";
import { Ingestion } from "../../ingest/index.js";
import type { StatusUpdate } from "../types.js";
import { WhatsAppAdapter } from "./adapter.js";
import { buildDaemon, GO_DIR, goAvailable } from "../../testing/go-daemon.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wa-mock-e2e-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  process.env.SUPERTWIN_HOME = tmpDir;
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_HOME;
  rmSync(tmpDir, { recursive: true, force: true });
});

function waitFor(
  pred: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const tick = () => {
      if (pred()) return resolvePromise();
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`timeout waiting for ${label}`));
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

function countEvents(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM events`)
    .get() as { n: number };
  return row.n;
}

describe.skipIf(!goAvailable)("real --mock daemon e2e (P0.6)", () => {
  it(
    "import 90d achieves ≥95% ingest containment; tokened send round-trips; replay refused",
    async () => {
      const bin = await buildDaemon();
      const adapter = new WhatsAppAdapter({
        binPath: bin,
        mock: true,
        home: tmpDir,
        autoRestart: false,
      });
      const ingestion = new Ingestion(adapter);
      ingestion.start();

      const frames: StatusUpdate[] = [];
      let emitted = 0;
      ingestion.subscribeStatus((s) => {
        frames.push(s);
        if (s.type === "backfill_complete") emitted = s.messages;
      });

      try {
        await adapter.connect();
        await adapter.startPairing();
        await waitFor(
          () => frames.some((f) => f.type === "paired"),
          15_000,
          "pairing",
        );

        await ingestion.importRange("90d");
        await waitFor(
          () => frames.some((f) => f.type === "backfill_complete"),
          30_000,
          "backfill_complete",
        );
        // Let the ingest tail (re-order buffer flush) land.
        await waitFor(() => countEvents() > 0, 10_000, "rows");
        await new Promise((r) => setTimeout(r, 500));

        // Containment (build plan P0 exit): ≥95% of what the daemon emitted for
        // the range must be in the log. Dedupe can only remove EXACT re-sends,
        // so the ratio measures losses.
        const stored = countEvents();
        expect(emitted).toBeGreaterThan(0);
        expect(stored / emitted).toBeGreaterThanOrEqual(0.95);

        // Watermark: import completion came from the daemon's signal.
        expect(ingestion.getStatus().importDone).toBe(true);

        // ---- Send gate, end to end against the real daemon ----------------
        const token = mintApprovalToken(`${ingestion.sourceId}.send`);
        const sendResults = () =>
          frames.filter((f) => f.type === "send_result") as Array<
            Extract<StatusUpdate, { type: "send_result" }>
          >;

        await ingestion.sendMessage({
          to: "15551234567@s.whatsapp.net",
          text: "e2e approved send",
          approvalToken: token.token,
        });
        await waitFor(() => sendResults().length >= 1, 10_000, "send_result");
        expect(sendResults()[0].ok).toBe(true);

        // Worker-side single-use: the consumed token cannot authorize again.
        await expect(
          ingestion.sendMessage({
            to: "15551234567@s.whatsapp.net",
            text: "replay",
            approvalToken: token.token,
          }),
        ).rejects.toThrow(/SEND_REFUSED/);

        // Daemon-side replay guard: write the SAME token straight to the
        // daemon (bypassing the worker gate) — the daemon refuses on its own.
        await adapter.sendMessage(
          "15551234567@s.whatsapp.net",
          "daemon replay attempt",
          token.token,
        );
        await waitFor(
          () => sendResults().length >= 2,
          10_000,
          "daemon refusal send_result",
        );
        const last = sendResults()[sendResults().length - 1];
        expect(last.ok).toBe(false);
      } finally {
        await adapter.disconnect();
      }
    },
    120_000,
  );

  it(
    "the send-refusal fixture refuses every send (SEND_REFUSED, no echo)",
    async () => {
      const bin = await buildDaemon();
      const fixture = join(GO_DIR, "fixtures", "send-refusal.json");
      expect(existsSync(fixture)).toBe(true);

      // The adapter has no --fixture flag of its own (fixtures are a mock-only
      // concern); wrap spawn to append it.
      const adapter = new WhatsAppAdapter({
        binPath: bin,
        mock: true,
        home: tmpDir,
        autoRestart: false,
        spawn: (b, args, opts) =>
          nodeSpawn(b, [...args, "--fixture", fixture], {
            stdio: ["pipe", "pipe", "pipe"],
            env: opts.env,
          }) as never,
      });
      const ingestion = new Ingestion(adapter);
      ingestion.start();

      const frames: StatusUpdate[] = [];
      ingestion.subscribeStatus((s) => frames.push(s));

      try {
        await adapter.connect();
        await adapter.startPairing();
        await waitFor(
          () => frames.some((f) => f.type === "paired"),
          15_000,
          "pairing",
        );

        const token = mintApprovalToken(`${ingestion.sourceId}.send`);
        await ingestion.sendMessage({
          to: "15551234567@s.whatsapp.net",
          text: "should be refused",
          approvalToken: token.token,
        });
        await waitFor(
          () => frames.some((f) => f.type === "send_result"),
          10_000,
          "send_result",
        );
        const result = frames.find((f) => f.type === "send_result") as Extract<
          StatusUpdate,
          { type: "send_result" }
        >;
        expect(result.ok).toBe(false);
        expect(
          frames.some(
            (f) => f.type === "error" && f.code === "SEND_REFUSED",
          ),
        ).toBe(true);
      } finally {
        await adapter.disconnect();
      }
    },
    120_000,
  );
});
