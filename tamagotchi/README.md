# Herogotchi 🦸

A standalone web app that turns **your face** (webcam or photo) into a **cute
superhero mascot** and keeps it alive as a Tamagotchi-style pet. It breathes,
blinks, looks around, waves, celebrates, talks, and can mirror your face live.

Not connected to SuperTwin. Everything lives in this folder.

## How it works

```
webcam / photo
  └─ on-device face check (MediaPipe): one face, size, angle, light, sharpness, eyes open
       └─ auto-capture the sharpest frame · level the eyes · head-and-shoulders crop (1024²)
            └─ image model: likeness-first prompt + your picks (style, suit, colors, accessories, power)
                 └─ cut-out (flood fill on the flat white background) · re-frame
                      └─ rig: find eyes/mouth/head (MediaPipe on the mascot) + arms (alpha scan)
                           └─ WebGL puppet: breathing, blinks, glances, jaw, head turn, arm wave/celebrate
                                └─ pet loop: food / joy / energy decay in real time, saved in your browser
```

All animation runs on your device. It's game-style rig animation, not
generated video, so every interaction after creation is free and instant.
**Mirror** mode drives the mascot's head, blinks and mouth from your webcam in
real time.

## Pick how heroes get drawn (one of these)

| Option | Cost | Setup |
|---|---|---|
| **A. Local on your Mac** (FLUX.2 Klein 4B via MFLUX) | Free, offline, private | Apple Silicon, ~15 GB one-time download. `npm run setup:local` |
| **B. Pollinations** (Nano Banana 2 by default) | Free credits ("Quest Pollen") | Create a secret key (`sk_…`) at enter.pollinations.ai, put it in `.env` |
| **C. Google Gemini** (Nano Banana 2) | ~$0.07 per image | `GEMINI_API_KEY` in `.env` (needs billing enabled) |
| Demo mode | Free | Nothing. You get a drawn placeholder hero, not your face |

The server picks automatically: local if MFLUX is installed, otherwise the
first key it finds, otherwise demo mode. Force a choice with `IMAGE_PROVIDER`.

## Run it

```bash
cd tamagotchi
npm install
cp .env.example .env        # optional: add a key (B/C) here
npm run setup:local         # optional: option A (Apple Silicon only)
npm run dev                 # UI http://localhost:5173 · API http://127.0.0.1:8787
```

`npm run dev` also stages the face model (`public/mediapipe/`, ~3.6 MB,
checksum-verified) on first run.

On a 16 GB Mac, local generation uses 8-bit quantization. It takes roughly
1–3 minutes per hero. If it runs out of memory, set `MFLUX_QUANTIZE=4` or
`MFLUX_LOW_RAM=1` in `.env`.

## Privacy and cost guards

- The photo is cropped in the browser and sent **once** to whichever provider
  you chose. With local mode it never leaves your Mac. The server never writes
  it to disk: the local provider's temp file is deleted right after each run.
- The pet (the mascot PNG and its stats) is stored only in your browser
  (IndexedDB). Your photo is never stored.
- The API server listens on `127.0.0.1` only, and keys stay server-side.
- Paid providers have a hard ceiling that is checked before every call:
  `MAX_GENERATIONS_PER_HOUR` (default 20) and `MAX_GENERATIONS_PER_DAY` (default 60).

## Develop

```bash
npm test            # unit tests: zero network or model calls (fake fetch + mock provider)
npm run typecheck
npm run build && npm start   # production: one server for UI + API on :8787
```

| Path | What |
|---|---|
| `src/face/` | face quality checks, geometry, smart crop, MediaPipe wrapper |
| `src/mascot/` | background cut-out, sprite framing, rig (face + arms) |
| `src/pet/` | WebGL puppet shader, idle animator, mirror mode, speech, pet rules |
| `src/ui/` | Capture → Customize → Creating → Pet screens |
| `server/` | tiny Node API: validation, prompt builder, budget, providers |
| `shared/options.ts` | the customization catalog (5 options per attribute) |

## Known limits (MVP)

- How well the likeness survives depends on the model. Nano Banana 2 is the
  strongest. Test FLUX.2 Klein 4B on your own face.
- Arms only animate when they stand clear of the body (the prompt asks for
  this). Otherwise the pet still breathes, blinks, talks and hops.
- The rig relies on the face finder working on the cartoon face. When it
  can't, it falls back to chibi proportions.
- The voice uses the browser's built-in speech. The pet speaks canned mood
  lines; there's no chat brain yet.
