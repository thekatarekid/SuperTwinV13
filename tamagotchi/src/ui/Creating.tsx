import { useEffect, useState } from "react";

const STEPS = [
  "Studying your hairstyle…",
  "Matching your smile…",
  "Sewing the super suit…",
  "Charging up powers…",
  "Adding extra cuteness…",
  "Teaching it to blink…",
];

interface Props {
  photo: string;
  error: string | null;
  local: boolean;
  onRetry: () => void;
  onBack: () => void;
}

export function Creating({ photo, error, local, onRetry, onBack }: Props) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (error) return;
    const t = setInterval(() => setI((n) => n + 1), 2400);
    return () => clearInterval(t);
  }, [error]);

  return (
    <section className="card creating">
      <div className={`morph ${error ? "" : "busy"}`}>
        <img src={photo} alt="" />
      </div>
      {error ? (
        <>
          <p className="coach bad">{error}</p>
          <div className="row">
            <button className="btn primary" onClick={onRetry}>
              Try again
            </button>
            <button className="btn" onClick={onBack}>
              Back
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="step">{STEPS[i % STEPS.length]}</p>
          <p className="muted small">
            {local ? "About 1–3 minutes on your Mac (the very first run also downloads the model)" : "Usually 10–40 seconds"}
            {i >= (local ? 40 : 6) ? " · almost there" : ""}
          </p>
          <button className="link" onClick={onBack}>
            Cancel
          </button>
        </>
      )}
    </section>
  );
}
