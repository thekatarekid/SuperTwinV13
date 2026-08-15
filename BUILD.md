# Building SuperTwinV11

## One command

```bash
cd ~/Documents/SuperTwinV11
npm ci
npm run build:app        # .app + .dmg
npm run build:appbundle  # .app only — skips the flaky bundle_dmg.sh step
```

Output: `src-tauri/target/release/bundle/dmg/SuperTwinV11_<version>_aarch64.dmg`
(and the raw `.app` under `bundle/macos/SuperTwinV11.app`).

**The `.dmg` is ~765 MB, up from ~636 MB.** The difference is the retrieval
encoder (129 MB), which v7 §7 bundles rather than downloading on first run; the
rest is the whisper model (574 MB), a full static ffmpeg (~52 MB) and yt-dlp
(~37 MB). Both choices are the same choice: the app transcribes
Hindi/Marathi/Hinglish audio and searches chats by meaning locally, on a machine
with no Homebrew, no ffmpeg on PATH and no network.

`build:app` runs five steps in order:

1. `vite build` — the frontend
2. `bundle-worker.mjs` — esbuild the worker, compile the Go daemon into it
3. `stage-node-sidecar.mjs` — copy your `node` to
   `src-tauri/binaries/node-<triple>` (Tauri ships it inside the .app)
4. `stage-media-tools.mjs` — fetch ffmpeg, build whisper-cli, fetch yt-dlp, the
   whisper model and the retrieval encoder
5. `tauri build` — the Rust shell, the .app and the .dmg

Step 3 exists because that ~113 MB Node binary is gitignored and never
committed, so a fresh clone has none. It used to be staged by hand; now it is
copied from whatever `node` runs the build, and skipped when already present.

Step 4 is the same idea for the media artefacts — see below.

## Bundled media toolchain

`npm run stage:media` (step 4, also runnable on its own) puts five artefacts
under `src-tauri/resources/`, all gitignored:

| Artefact | Size | Where it comes from |
|---|---|---|
| `bin/ffmpeg` | ~52 MB | downloaded, full static arm64 build 8.1 |
| `bin/whisper-cli` | ~3 MB | compiled here from whisper.cpp v1.9.1, arm64 + Metal |
| `bin/yt-dlp` | ~37 MB | downloaded, the 2026.07.04 macOS release asset |
| `models/ggml-large-v3-turbo-q5_0.bin` | 574 MB | downloaded from the ggerganov/whisper.cpp HF repo |
| `models/embeddings/Xenova/multilingual-e5-small/` | 129 MB, 4 files | downloaded from the Xenova HF repo |

The first run downloads ~770 MB, so budget anywhere from minutes to most of an
hour depending on the link; after that everything is skipped and the script
returns in seconds. Each download is checked against a SHA-256 pinned in
`scripts/stage-media-tools.mjs` and a mismatch **fails the build** — a silently
corrupt model still loads and still produces confident-looking transcripts, and
a truncated ONNX graph still produces vectors, in a space where nothing looks
wrong. whisper-cli is compiled, so its bytes are not reproducible; it is
verified by running it and by requiring it to link `Metal.framework`. The script
finishes with a real end-to-end spin: ffmpeg makes a second of silence,
whisper-cli transcribes it on the GPU, yt-dlp is made to list the YouTube
extractor it is bundled for, and the encoder is loaded with
`allowRemoteModels: false` and made to produce a 384-d unit vector.

Every binary is ad-hoc signed here with `src-tauri/entitlements.plist`,
exactly like the Go daemon, because Tauri copies resources verbatim and signs
only the outer `.app` — and macOS refuses to execute an unsigned arm64 Mach-O.

They ship as Tauri **resources**, not `externalBin`: `externalBin` renames the
file with a target-triple suffix and is reachable only through Rust's sidecar
API, whereas the process that spawns them is the Node worker.
`tauri.conf.json` names each file individually rather than the two directories,
because the bundler skips an empty directory silently but fails loudly on a
missing file. Runtime paths:

| | the three binaries | models |
|---|---|---|
| dev (from source) | `src-tauri/resources/bin/…` | `src-tauri/resources/models/…` |
| packaged `.app` | `SuperTwinV11.app/Contents/Resources/bin/…` | `…/Contents/Resources/models/…` |

The worker resolves all of them from the directory `worker.cjs` sits in, never
from `process.cwd()` — esbuild rewrites `import.meta` to an empty object in the
CJS bundle, and a cwd-relative path resolves in the repo and nowhere else inside
the `.app`. `scripts/stage-media-tools.test.mjs` builds a real CJS bundle into a
simulated `Contents/Resources` tree and runs it from an unrelated cwd, because
that is the failure this shipped with twice.

### yt-dlp

It is there for one thing (v6 §4): the caption track of a YouTube link, which
is the only place a video's spoken content exists as text. It runs behind the
link-scrape switch, is never pointed at anything but `youtube.com`, and is
handed a URL rebuilt from the eleven-character video id rather than the string
the message contained. Instagram is deliberately **not** routed through it —
reels have no caption track, `og:` already carries the whole caption, and
yt-dlp against Instagram needs cookies.

Two things about it are worth knowing before you touch it:

- **It is universal2 and stays that way.** `lipo -thin arm64` would halve the
  37 MB, and it would also break it: the PyInstaller archive is carried past
  the end of the Mach-O images, and lipo rebuilds the file from the images.
- **It costs ~10 s per run before it does anything**, because it unpacks
  itself into a temp directory each time. A YouTube link therefore takes ~13 s
  end to end. That is why captions are fetched from the idle link queue and not
  on the path of anything a person is waiting for.

Its digest does not go stale: GitHub release assets are immutable, so re-pinning
is only ever a deliberate version bump.

### The retrieval encoder

`multilingual-e5-small` int8 — 12-layer XLM-R, 384 dims, trained on romanised
text, which is what Hinglish is. It is bundled for the same reason the whisper
model is (v7 §7): the tier's canonical case is *cold* ↔ *health*, and a machine
that has to find 129 MB of network before it can answer that is a machine where
searching by meaning is simply off.

The four files land in the layout `@huggingface/transformers` resolves a cached
model to — `<cacheDir>/<repo id>/<file>` — so loading the bundled copy is
`env.cacheDir = Contents/Resources/models/embeddings` and nothing else. Their
digests and sizes are pinned once, in `worker/src/retrieval/embedder.ts`, and
the staging script reuses them; a test fails if the two lists ever drift,
because two sets of digests for one model is how a build ships weights that rank
nothing like the ones Settings would have fetched.

The Settings download button still works and is still the path for a build that
was never staged. It writes to `~/SuperTwinV11/models/embeddings/`, and that
directory stays the only one the app ever writes to or deletes from — removing a
file from inside a signed `.app` breaks the app.

Models the user downloads later from the model selector do **not** go here.
They live in `~/SuperTwinV11/models/`, outside the app, so an app update never
re-downloads them.

The bundled ffmpeg is a GPL build (`--enable-gpl`, no `--enable-nonfree`).
Shipping it puts the usual GPL source-offer obligation on the `.dmg`.

## Toolchains required

| Tool | Why | Install |
|---|---|---|
| Node 20+ | frontend + worker | already have it |
| Rust stable | the Tauri shell | `curl https://sh.rustup.rs -sSf \| sh` |
| Go 1.21+ | the whatsmeow daemon | `brew install go` |
| Xcode CLT | linking + codesign | `xcode-select --install` |
| CMake 3.5+ | building whisper-cli | `brew install cmake` |
| Network | the first `stage:media` only | ~770 MB, once |

The *built app* needs none of this — that is the point of bundling. The
network requirement is on the build machine, for the first build only.

I could not produce the `.dmg` here — this sandbox has Node but no Rust, Go, or
Xcode, and macOS bundles only build on macOS. Everything that *can* be verified
without them is verified (below).

## First run

The app defaults to `~/SuperTwinV11` and starts empty. **Nothing is migrated
from V8** — that is deliberate. Launch it, scan the QR, and let it build its own
data from scratch. `~/SuperTwinV8` is never read, never written, never touched.

---

## What the V8 → V11 fork changes

Every identity surface moved, so a V11 install cannot fall back onto V8 state:

| Surface | SuperTwinV8 | SuperTwinV11 |
|---|---|---|
| macOS app name | SuperTwinV8 | **SuperTwinV11** |
| Bundle identifier | `com.supertwin.v8` | **`com.supertwin.v11`** |
| Window title | SuperTwinV8 | **SuperTwinV11** |
| Data folder | `~/SuperTwinV8` | **`~/SuperTwinV11`** |
| Database | `~/SuperTwinV8/supertwin.db` | **`~/SuperTwinV11/supertwinv11.db`** |
| Brain / media / models | `~/SuperTwinV8/…` | **`~/SuperTwinV11/…`** |
| Logs folder | `~/SuperTwinV8/logs/` | **`~/SuperTwinV11/logs/`** |
| `worker.log` (Rust) | `~/SuperTwinV8/worker.log` | **`~/SuperTwinV11/worker.log`** |
| WhatsApp session store | `~/SuperTwinV8/whatsapp/whatsmeow.db` | **`~/SuperTwinV11/whatsapp/whatsmeow.db`** |
| Worker HTTP port | 8787 | **8011** |
| npm package | `supertwinv8`, `@supertwinv8/worker` | **`supertwinv11`, `@supertwinv11/worker`** |
| Rust crate | `supertwinv8`, `supertwinv8_lib` | **`supertwinv11`, `supertwinv11_lib`** |
| WhatsApp Linked Devices | SuperTwinV8 | **SuperTwinV11** |
| Chat identity (system prompt) | "You are SuperTwinV8" | **"You are SuperTwinV11"** |
| Link-preview user agent | `SuperTwin/1.0` | **`SuperTwinV11/1.0`** |
| Sidebar / chat / settings copy | SuperTwinV8 | **SuperTwinV11** |
| Brain git commit author | SuperTwinV8 | **SuperTwinV11** |

The DB **filename** changed too (`supertwin.db` → `supertwinv11.db`), so even
pointing `SUPERTWIN_HOME` at an old folder cannot open the V8 database.

The **worker port** moved to 8011 for the same reason: on 8787 a V11 window
would happily talk to a V8 worker that happened to already be running, and the
UI would look correct while reading the wrong data.

The distinct bundle identifier means macOS treats this as a separate app: V8 and
V11 can both sit in `/Applications` and run side by side without clobbering each
other.

`SUPERTWIN_HOME` still overrides the data folder if you ever want to point a
build somewhere else. If you have it exported globally from V8 work, unset it
before launching V11 — an explicit override beats the new default.

---

## Verification (this sandbox)

| Check | Result |
|---|---|
| worker typecheck | clean |
| worker tests | 908 passed |
| frontend typecheck | clean |
| frontend tests | 228 passed |
| `vite build` | clean |
| esbuild worker bundle | 139.5 kB, clean |
| Go daemon compile | **not run** — no Go toolchain |
| Rust / `.dmg` | **not run** — no Rust, no macOS |

The two unrun steps are exactly what `npm run build:app` does on your Mac. The
Go daemon source is unchanged from `main` apart from the one-line device-name
string, and its own Go unit test was updated to match.

## If the build fails

- **`npm ci` → `EUSAGE ... Missing <pkg> from lock file`** — the lockfile and
  package.json disagree. Fixed as of `df80729`; if it recurs, run `npm install`
  (not `ci`) once to regenerate the lock on your own machine, then commit it.
- **`sh: tsc: command not found`** — `npm ci` failed earlier in the chain, so
  `node_modules` was never created. Fix the install, then rebuild.
- **`resource path 'binaries/node-aarch64-apple-darwin' doesn't exist`** — the
  Node sidecar wasn't staged. `npm run stage:node` fixes it; `build:app` now
  does it automatically.
- **Sidecar crashes at launch / `better_sqlite3.node` won't load** — the staged
  node's ABI may not match the prebuilt native addon. Copy the known-good
  binary from the old repo instead:
  `cp ~/Documents/SuperTwin-Whatsapp/src-tauri/binaries/node-aarch64-apple-darwin src-tauri/binaries/`
- **`go build failed … ENOENT`** — Go isn't installed or isn't on PATH.
- **`resource path 'resources/bin/ffmpeg' doesn't exist`** (or `whisper-cli`,
  or `yt-dlp`, or either model) — `npm run stage:media` hasn't run, or it
  failed. Run it alone to see why; `build:app` runs it automatically.
- **`cmake is required to build whisper-cli`** — `brew install cmake`.
- **`error: linker 'cc' not found`** — run `xcode-select --install`.
- **Codesign errors** — `tauri.conf.json` uses `"signingIdentity": "-"`
  (ad-hoc). That's fine locally; Gatekeeper will warn on another machine.
- **`failed to bundle project: error running bundle_dmg.sh`** — the `.app` is
  already built and signed at `bundle/macos/SuperTwinV11.app`; only the disk-image
  wrapper failed. Use `npm run build:appbundle` to skip it, or clear a stale
  mount with `hdiutil detach /Volumes/SuperTwinV11` and retry.
- **Stale Rust artifacts after the crate rename** — `rm -rf src-tauri/target`
  and rebuild. The crate went `supertwin` → `supertwinv11`, so a cached target
  dir can confuse the linker.

## When a download fails

`stage:media` pulls ~770 MB. It never leaves a half-downloaded file looking
staged — everything lands in a `.part` file first and is only renamed after its
SHA-256 matches.

- **The transfer died / you lost the network.** The `.part` file stays in
  `src-tauri/resources/.cache/`. Rerun `npm run stage:media` and curl resumes
  from where it stopped. Nothing needs cleaning up first — unless resuming
  itself keeps failing, in which case delete the `.part` file and start over.
- **`SHA-256 mismatch … refusing to use it`.** The partial download is deleted,
  so the first thing to try is simply rerunning — a corrupt transfer fixes
  itself. If the *same* digest comes back twice, upstream republished the file:
  - **ffmpeg.** `osxexperts.net` reuses one filename for every 8.1.x point
    release, so this one does go stale. Fetch the zip by hand, run
    `shasum -a 256` on the zip and on the `ffmpeg` inside it, and update
    `archiveSha256`, `archiveBytes` and `binarySha256` in
    `scripts/stage-media-tools.mjs`. Check the new build is still
    `--enable-gpl` and *not* `--enable-nonfree`, or it cannot be shipped.
  - **The two models and yt-dlp.** Both model URLs are pinned to a HuggingFace
    revision and yt-dlp's is a GitHub release asset, so upstream cannot change
    any of them. A repeated mismatch means bad bytes, or a proxy serving an HTML
    error page instead of the file.
- **No network at all.** There is no fallback: the model is the build. If you
  already have `ggml-large-v3-turbo-q5_0.bin` on the machine, copy it to
  `src-tauri/resources/models/` and rerun — the script checksums what it finds
  and keeps it rather than downloading again.
- **Out of disk.** Budget ~1.2 GB: ~840 MB staged and cached for good, plus a
  transient ~300 MB whisper build tree that is deleted once whisper-cli is
  verified.
- **Behind a proxy.** curl is spawned plainly, so `https_proxy` is honoured.
