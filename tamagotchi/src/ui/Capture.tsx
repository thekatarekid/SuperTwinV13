import { useCallback, useEffect, useRef, useState } from "react";
import { planCrop, renderCrop } from "../face/crop.ts";
import type { FaceGeometry } from "../face/geometry.ts";
import { blendshape, getLandmarker } from "../face/landmarker.ts";
import { assessPhoto, type Assessment } from "../face/quality.ts";

// Step 1: get one great face photo. The webcam path coaches the user live and
// auto-captures the sharpest frame once everything is green; the upload path
// runs the same checks and re-crops/levels the face for them.

interface Props {
  onPhoto: (croppedJpeg: string) => void;
}

export function Capture({ onPhoto }: Props) {
  const [mode, setMode] = useState<"webcam" | "upload">("webcam");
  return (
    <section className="card capture">
      <h2>1 · Your face</h2>
      <p className="muted">One face, facing forward, in good light. It stays on your device until you press Create.</p>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={mode === "webcam"} className={mode === "webcam" ? "tab on" : "tab"} onClick={() => setMode("webcam")}>
          📷 Webcam
        </button>
        <button role="tab" aria-selected={mode === "upload"} className={mode === "upload" ? "tab on" : "tab"} onClick={() => setMode("upload")}>
          🖼️ Upload photo
        </button>
      </div>
      {mode === "webcam" ? <Webcam onPhoto={onPhoto} onFallback={() => setMode("upload")} /> : <Upload onPhoto={onPhoto} />}
    </section>
  );
}

function Checklist({ a, loading }: { a: Assessment | null; loading?: boolean }) {
  if (loading) return <p className="coach">Loading face finder…</p>;
  if (!a) return null;
  const firstBad = a.checks.find((c) => !c.ok);
  return (
    <div className="checks" aria-live="polite">
      <p className={`coach ${a.perfect ? "good" : firstBad?.severity === "block" ? "bad" : "warn"}`}>
        {a.perfect ? "Perfect — hold still ✨" : firstBad?.tip}
      </p>
      <ul>
        {a.checks.map((c) => (
          <li key={c.id} className={c.ok ? "ok" : c.severity}>
            {c.ok ? "✓" : c.severity === "block" ? "✕" : "!"} {c.ok ? label(c.id) : c.tip}
          </li>
        ))}
      </ul>
    </div>
  );
}

const LABELS: Record<string, string> = {
  face: "Face",
  single: "One person",
  size: "Distance",
  centered: "Centered",
  angle: "Facing forward",
  light: "Light",
  sharp: "Sharp",
  eyes: "Eyes open",
};
const label = (id: string) => LABELS[id] ?? id;

interface Frame {
  canvas: HTMLCanvasElement;
  geo: FaceGeometry;
  score: number;
}

function Webcam({ onPhoto, onFallback }: Props & { onFallback: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [flash, setFlash] = useState(false);
  const latest = useRef<Frame | null>(null);
  const done = useRef(false);

  const finish = useCallback(
    (frame: Frame) => {
      if (done.current) return;
      done.current = true;
      setFlash(true);
      const crop = renderCrop(frame.canvas, frame.canvas.width, frame.canvas.height, planCrop(frame.geo));
      setTimeout(() => onPhoto(crop.toDataURL("image/jpeg", 0.92)), 180);
    },
    [onPhoto],
  );

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    const work = document.createElement("canvas");
    const wctx = work.getContext("2d", { willReadFrequently: true })!;
    let lastRun = 0;
    let streak = 0;
    let countdownStart: number | null = null;
    let best: Frame | null = null;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch (e) {
        const name = (e as DOMException).name;
        setError(
          name === "NotAllowedError"
            ? "Camera permission was denied. Allow it in the address bar, or upload a photo instead."
            : "No camera found. Upload a photo instead.",
        );
        setLoading(false);
        return;
      }
      if (stopped) return stream.getTracks().forEach((t) => t.stop());
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play().catch(() => {});
      let lm;
      try {
        lm = await getLandmarker("VIDEO");
      } catch {
        setError("The face finder couldn't load. Run `npm run setup:models`, then reload.");
        setLoading(false);
        return;
      }
      setLoading(false);

      const loop = (now: number) => {
        if (stopped) return;
        raf = requestAnimationFrame(loop);
        if (now - lastRun < 160 || video.readyState < 2 || done.current) return;
        lastRun = now;
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (work.width !== w) {
          work.width = w;
          work.height = h;
        }
        wctx.drawImage(video, 0, 0, w, h);
        const res = lm.detectForVideo(video, now);
        const image = wctx.getImageData(0, 0, w, h);
        const a = assessPhoto({
          faces: res.faceLandmarks,
          image,
          blink: res.faceLandmarks.length ? { left: blendshape(res, "eyeBlinkLeft"), right: blendshape(res, "eyeBlinkRight") } : undefined,
          mode: "webcam",
        });
        setAssessment(a);
        if (a.usable && a.geometry) {
          latest.current = { canvas: snapshot(work), geo: a.geometry, score: a.score };
        }

        // Auto-capture: all green for ~0.6 s → 3-2-1, keeping the sharpest frame.
        streak = a.perfect ? streak + 1 : 0;
        if (countdownStart === null && streak >= 4) {
          countdownStart = now;
          best = null;
        }
        if (countdownStart !== null) {
          if (!a.usable) {
            countdownStart = null;
            setCountdown(null);
            return;
          }
          if (a.geometry && (!best || a.score > best.score)) best = { canvas: snapshot(work), geo: a.geometry, score: a.score };
          const left = 3 - Math.floor((now - countdownStart) / 1000);
          setCountdown(left > 0 ? left : null);
          if (left <= 0 && best) finish(best);
        }
      };
      raf = requestAnimationFrame(loop);
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [finish]);

  if (error) {
    return (
      <div className="notice">
        <p>{error}</p>
        <button className="btn" onClick={onFallback}>
          Upload a photo
        </button>
      </div>
    );
  }

  return (
    <div className="webcam">
      <div className={`viewfinder ${assessment?.perfect ? "good" : ""}`}>
        <video ref={videoRef} muted playsInline aria-label="Camera preview" />
        <div className="oval" aria-hidden />
        {countdown !== null && <div className="countdown">{countdown}</div>}
        {flash && <div className="flash" />}
      </div>
      <Checklist a={assessment} loading={loading} />
      <button
        className="btn primary"
        disabled={!assessment?.usable}
        onClick={() => latest.current && finish(latest.current)}
        title="Captures automatically when everything is green"
      >
        📸 Snap now
      </button>
    </div>
  );
}

function snapshot(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  c.getContext("2d")!.drawImage(src, 0, 0);
  return c;
}

function Upload({ onPhoto }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ crop: string; a: Assessment } | null>(null);
  const [drag, setDrag] = useState(false);

  const handle = useCallback(async (file: File | undefined | null) => {
    if (!file) return;
    setError(null);
    setPreview(null);
    if (!file.type.startsWith("image/")) return setError("That isn't an image file.");
    setBusy(true);
    try {
      let bmp: ImageBitmap;
      try {
        bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      } catch {
        throw new Error("Your browser can't read this format (HEIC?). Export it as JPEG or PNG and try again.");
      }
      // Big phone photos: 2048 px is plenty for the face finder and the crop.
      const scale = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * scale);
      c.height = Math.round(bmp.height * scale);
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close();
      const lm = await getLandmarker("IMAGE");
      const res = lm.detect(c);
      const a = assessPhoto({
        faces: res.faceLandmarks,
        image: ctx.getImageData(0, 0, c.width, c.height),
        blink: res.faceLandmarks.length ? { left: blendshape(res, "eyeBlinkLeft"), right: blendshape(res, "eyeBlinkRight") } : undefined,
        mode: "upload",
      });
      if (!a.usable || !a.geometry) {
        setPreview(null);
        setError(a.checks.find((ch) => !ch.ok)?.tip ?? "This photo won't work — try another.");
        return;
      }
      const crop = renderCrop(c, c.width, c.height, planCrop(a.geometry));
      setPreview({ crop: crop.toDataURL("image/jpeg", 0.92), a });
    } catch (e) {
      setError((e as Error).message || "Couldn't read that photo.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
      if (item) void handle(item.getAsFile());
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [handle]);

  const warnings = preview?.a.checks.filter((c) => !c.ok) ?? [];

  return (
    <div className="upload">
      <label
        className={`drop ${drag ? "drag" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          void handle(e.dataTransfer.files[0]);
        }}
      >
        <input type="file" accept="image/*" onChange={(e) => void handle(e.target.files?.[0])} hidden />
        {busy ? "Finding your face…" : preview ? "Choose a different photo" : "Drop a selfie here, click to browse, or paste (Ctrl/⌘+V)"}
      </label>
      {error && <p className="coach bad">{error}</p>}
      {preview && (
        <div className="preview">
          <img src={preview.crop} alt="Your cropped face" />
          <div>
            {warnings.length ? (
              <ul className="checks">
                {warnings.map((w) => (
                  <li key={w.id} className="warn">
                    ! {w.tip}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="coach good">Great photo ✨</p>
            )}
            <button className="btn primary" onClick={() => onPhoto(preview.crop)}>
              Use this photo
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
