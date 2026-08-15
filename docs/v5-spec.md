# Session 5 — video frames and audio transcription

Frozen contract. Builds on v4. Every new capability is **off by default**.

## Decisions taken

| | Chosen |
|---|---|
| Video | Multiple frames **and** audio, each behind its own switch |
| Audio engine | whisper.cpp, local, nothing leaves the machine |
| Bundled model | `ggml-large-v3-turbo-q5_0.bin` (574 MB) |
| Other models | selectable, downloaded on demand |
| ffmpeg | full static build, bundled |

`.dmg` grows from ~47 MB to ~700 MB. That is the cost of working offline with
real Hindi/Marathi accuracy, and it was chosen deliberately.

### Why turbo-q5_0 and not base

`base` (148 MB) is weak on Hindi and poor on Hinglish code-switching, which is
most of this user's audio. `large-v3-turbo-q5_0` is 574 MB — barely more than
`small` (488 MB) — at near-`large-v3` accuracy and roughly 8× its speed.

Selector offers: `tiny` 77 MB · `base` 148 MB · `small` 488 MB ·
`medium-q5_0` 539 MB · **`large-v3-turbo-q5_0` 574 MB (bundled default)** ·
`large-v3-turbo` 1.62 GB · `large-v3-q5_0` 1.08 GB · `large-v3` 3.1 GB.
English-only `.en` variants are deliberately excluded — they cannot serve these
chats.

## 1. Bundled binaries

- **ffmpeg** — full static arm64 build, shipped as a Tauri resource.
- **whisper.cpp** — `whisper-cli` built for arm64 with Metal, shipped alongside.
- **model** — `ggml-large-v3-turbo-q5_0.bin` shipped in the app; downloaded
  models land in `~/SuperTwinV8/models/` so an app update never re-downloads.

Both binaries are invoked as child processes, never through a shell. Media
paths are attacker-controlled — pass argv arrays, never a command string.

A build script stages all three, mirroring `stage-node-sidecar.mjs`. The model
is large and must **not** be committed to git; the staging script fetches and
checksums it, and CI/build fails loudly if the checksum does not match.

## 2. Video frames

Behind `media.video_frames_enabled` (**off**).

- Sample frames across the clip: one every `media.video_frame_interval_sec`
  (default 5), capped at `media.video_frame_max` (default 8). A 20 s clip gives
  4 frames; a 10 min clip gives 8 spread evenly, not the first 40 s.
- Write to `<mediaDir>/<chat>/<msgID>.frame<N>.jpg`, downscaled — a full-res
  frame wastes tokens for no descriptive gain.
- All frames for one video go in **one** call, described as a sequence so the
  model can say what changes, not as N unrelated stills.
- Frames are cleaned up if the video row is revoked.

This supersedes the single-thumbnail path when enabled. With it off, behaviour
is exactly as today: one thumbnail, or `unsupported` when there is none.

## 3. Audio transcription

Two independent switches, both **off**:

- `media.voice_notes_enabled` — voice notes and audio attachments
- `media.video_audio_enabled` — the audio track inside videos

Pipeline: ffmpeg → 16 kHz mono WAV → `whisper-cli` → text.

- Language is **auto-detected**, not forced to English. These chats are Hindi,
  Marathi, English and code-switched Hinglish; forcing a language would silently
  mangle most of it.
- Transcripts land in a `transcript` column with their own
  `transcript_status` / `transcript_model` / `transcript_error`, mirroring the
  media-description lifecycle, and are indexed in `events_fts` so voice notes
  become searchable.
- Cost is **zero tokens** — whisper is local. It costs wall-clock and CPU/GPU,
  so it runs through the same throttled queue and must never block a media
  description or a chat turn.
- Long audio is chunked; a partial transcript is recorded as partial rather
  than being passed off as complete.

Whisper hallucinates confident text on silence and on music. Detect empty or
degenerate output (repeated n-grams, single repeated phrase) and record
`unsupported` rather than storing an invented sentence.

## 4. Settings

New controls, all off by default except where stated:

- Video frames — with interval and max-frames
- Video audio
- Voice notes and audio attachments
- Whisper model selector, showing size and download state, with per-model
  download and delete
- Visible state for the bundled binaries: present, version, model on disk

Copy must be honest: transcription is local and free of tokens, but it is not
instant and it is not perfect on noisy audio.

## 5. What must not regress

- Everything new is off by default, so an existing install behaves identically
  until the user opts in.
- Media description and chat keep priority over transcription in the queue.
- The `.dmg` still installs and launches on a machine with no Homebrew, no
  ffmpeg on PATH and no network — that is the entire point of bundling.
