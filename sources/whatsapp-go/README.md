# whatsapp-go

SuperTwin's WhatsApp ingestion daemon (Phase 1, Task 2). A read-only whatsmeow
client that speaks the NDJSON protocol from `docs/PHASE1_CONTRACT.md` over
stdio: the Node worker sends commands on **stdin** and reads events on
**stdout**; all diagnostic logging goes to **stderr**.

**Ingestion is read-only.** There is exactly ONE send path — `send_message` —
and it is code-gated (V6 P1 S4.5, spec §2.13): the daemon refuses it unless the
command carries an approval token that verifies against this install's approval
key (`SUPERTWIN_APPROVAL_KEY`, handed over in the spawn environment by the
worker), names the send action, has not expired, is bound to *exactly* this
recipient and this text, and has not already driven a send through this
process. No key, no send — an unverifiable gate is an open gate. See
`internal/daemon/sendgate.go`; the worker mints the tokens in
`worker/src/approvals/`.

## Build

```bash
make build          # -> ./whatsapp-go (host arch)
make build-arm64    # cross-compile for Apple Silicon (aarch64-apple-darwin)
# or:
./build.sh          # host
./build.sh arm64    # darwin/arm64
```

CGO is disabled (`CGO_ENABLED=0`) — the SQLite session store uses the pure-Go
`modernc.org/sqlite` driver, so the binary is self-contained and
cross-compilable (no libsqlite3, no C toolchain, runs inside the ad-hoc-signed
`.app`).

## Run

```bash
./whatsapp-go --session-db <path> --media-dir <path> --log-level info
```

Flags: `--session-db` `--media-dir` `--log-level` `--mock` `--fixture <path>`.
With an existing session the daemon auto-connects toward `online` without
pairing. Commands (one JSON per line on stdin): `start_pairing`, `import`,
`extend`, `pause`, `resume`, `logout`, `shutdown`. SIGTERM/SIGINT trigger the
same clean shutdown as `shutdown`.

## Mock mode (CI, no WhatsApp account)

`--mock` (or `SUPERTWIN_WHATSAPP_MOCK=1`) replays a synthetic fixture through
the exact same protocol — fake QR/pairing, range-filtered backfill with
progress, media written to disk. Override the built-in fixture with
`--fixture <path.json>`.

```bash
printf '%s\n' '{"cmd":"start_pairing"}' '{"cmd":"import","range":"7d"}' '{"cmd":"shutdown"}' \
  | ./whatsapp-go --mock --session-db /tmp/st-wa/session.db --media-dir /tmp/st-wa/media
```

## Layout

- `main.go` — CLI flags, mode selection, wiring.
- `internal/protocol` — canonical Event/Channel/Actor shapes + NDJSON reader/writer.
- `internal/rangefilter` — pure `RangeCutoff` + chat/message range predicates (contract §4).
- `internal/daemon` — stdin command loop, signals, bounded graceful shutdown; `Engine` interface.
- `internal/wa` — real whatsmeow engine (pairing, session, live, history sync, media, reconnect).
- `internal/mock` — synthetic fixture + range-filtered replay engine.

## Test

```bash
make test    # go test ./...
```
