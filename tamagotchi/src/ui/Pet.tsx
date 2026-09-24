import { useCallback, useEffect, useRef, useState } from "react";
import { loadImage } from "../mascot/process.ts";
import { Animator, type Reaction } from "../pet/animator.ts";
import { applyMirror, Mirror, type MirrorSample } from "../pet/mirror.ts";
import { Puppet } from "../pet/puppet.ts";
import { canSpeak, speak } from "../pet/speech.ts";
import { act, lineFor, moodOf, tick, type Action, type PetStats } from "../pet/state.ts";
import type { SavedPet } from "../storage.ts";

interface Props {
  pet: SavedPet;
  fresh: boolean;
  onStats: (stats: PetStats) => void;
  onKeep: () => void;
  onRegenerate: () => void;
  onNewPet: () => void;
}

interface Particle {
  id: number;
  emoji: string;
  x: number;
}

const MOOD_LABEL = {
  sleeping: "💤 Sleeping",
  hungry: "🍽️ Hungry",
  tired: "🥱 Tired",
  sad: "🥺 Lonely",
  happy: "😄 Happy",
  okay: "🙂 Okay",
} as const;

export function Pet({ pet, fresh, onStats, onKeep, onRegenerate, onNewPet }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animator = useRef(new Animator());
  const mirror = useRef<Mirror | null>(null);
  const mirrorSample = useRef<MirrorSample | null>(null);
  const stopTalking = useRef<() => void>(() => {});
  const [stats, setStats] = useState(() => tick(pet.stats, Date.now()));
  const [glFailed, setGlFailed] = useState(false);
  const [bubble, setBubble] = useState<string | null>(null);
  const [particles, setParticles] = useState<Particle[]>([]);
  const [mirrorOn, setMirrorOn] = useState(false);
  const [mirrorError, setMirrorError] = useState<string | null>(null);
  const pipRef = useRef<HTMLDivElement>(null);
  const mood = moodOf(stats);
  animator.current.mood = mood;

  // Keep stats flowing in real time and persisted.
  useEffect(() => {
    const t = setInterval(() => setStats((s) => tick(s, Date.now())), 5000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => onStats(stats), [stats, onStats]);

  // Puppet render loop.
  useEffect(() => {
    let raf = 0;
    let puppet: Puppet | null = null;
    let disposed = false;
    let sampling = false;
    (async () => {
      const img = await loadImage(pet.sprite.png);
      if (disposed || !canvasRef.current) return;
      try {
        puppet = new Puppet(canvasRef.current, img, pet.sprite.rig);
      } catch {
        setGlFailed(true);
        return;
      }
      const loop = (now: number) => {
        raf = requestAnimationFrame(loop);
        let params = animator.current.frame(now);
        const m = mirror.current;
        if (m) {
          if (!sampling) {
            sampling = true;
            m.sample(now)
              .then((s) => (mirrorSample.current = s))
              .catch(() => {})
              .finally(() => (sampling = false));
          }
          if (mirrorSample.current) params = applyMirror(params, mirrorSample.current);
        }
        puppet!.render(params);
      };
      raf = requestAnimationFrame(loop);
    })();
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      puppet?.dispose();
    };
  }, [pet.sprite]);

  useEffect(
    () => () => {
      mirror.current?.stop();
      stopTalking.current();
    },
    [],
  );

  const burst = useCallback((emoji: string, n = 5) => {
    const now = Date.now();
    const add = Array.from({ length: n }, (_, i) => ({ id: now + i + Math.random(), emoji, x: 20 + Math.random() * 60 }));
    setParticles((p) => [...p, ...add]);
    setTimeout(() => setParticles((p) => p.filter((q) => !add.includes(q))), 1600);
  }, []);

  const say = useCallback((text: string, voice = true) => {
    if (voice) animator.current.react("wave", performance.now());
    setBubble(text);
    window.setTimeout(() => setBubble((b) => (b === text ? null : b)), 3200);
    if (voice && canSpeak()) {
      stopTalking.current();
      stopTalking.current = speak(text, (level) => (animator.current.talk = level));
    }
  }, []);

  const doAction = (action: Action) => {
    const now = Date.now();
    const res = act(stats, action, now);
    setStats(res.stats);
    if (!res.accepted) {
      animator.current.react("refuse", performance.now());
      if (res.reason) say(res.reason, false);
      return;
    }
    const reactions: Record<Action, Reaction | null> = { feed: "eat", play: "play", sleep: null, wake: "wake" };
    const r = reactions[action];
    if (r) animator.current.react(r, performance.now());
    if (action === "feed") burst(["🍎", "🍩", "🍕", "🍓"][Math.floor(Math.random() * 4)], 4);
    if (action === "play") burst("💖", 6);
    if (action === "wake") say("Good morning, hero!");
  };

  const toggleMirror = async () => {
    if (mirror.current) {
      mirror.current.stop();
      mirror.current = null;
      mirrorSample.current = null;
      setMirrorOn(false);
      return;
    }
    setMirrorError(null);
    const m = new Mirror();
    try {
      await m.start();
    } catch {
      setMirrorError("Couldn't open the camera for mirror mode.");
      return;
    }
    mirror.current = m;
    setMirrorOn(true);
    const v = m.element;
    v.className = "pip-video";
    pipRef.current?.replaceChildren(v);
  };

  const download = () => {
    const a = document.createElement("a");
    a.href = pet.sprite.png;
    a.download = `${pet.name || "my-hero"}.png`;
    a.click();
  };

  return (
    <section className="pet-screen">
      {fresh && (
        <div className="card likeness">
          <p>
            <strong>Meet {pet.name || "your hero"}!</strong> Does it look like you?
          </p>
          <div className="row">
            <button className="btn primary" onClick={onKeep}>
              Love it
            </button>
            <button className="btn" onClick={onRegenerate}>
              🎲 Try again
            </button>
          </div>
        </div>
      )}

      <div className={`device mood-${mood}`}>
        <div className="device-top">
          <span className="pet-name">{pet.name || "Hero"}</span>
          <span className="mood">{MOOD_LABEL[mood]}</span>
        </div>
        <div
          className={`screen ${stats.asleep ? "night" : ""}`}
          onClick={() => {
            if (stats.asleep) return;
            animator.current.react("tap", performance.now());
            say(lineFor(mood, pet.name), false);
          }}
        >
          {glFailed ? (
            <img className="fallback-sprite" src={pet.sprite.png} alt={`${pet.name}, your superhero pet`} />
          ) : (
            <canvas ref={canvasRef} className="puppet" aria-label={`${pet.name}, your superhero pet`} />
          )}
          <div className="floor-shadow" aria-hidden />
          {stats.asleep && <div className="zzz" aria-hidden>z z Z</div>}
          {particles.map((p) => (
            <span key={p.id} className="particle" style={{ left: `${p.x}%` }} aria-hidden>
              {p.emoji}
            </span>
          ))}
          {bubble && <div className="bubble">{bubble}</div>}
          <div ref={pipRef} className={`pip ${mirrorOn ? "on" : ""}`} />
        </div>

        <div className="stats">
          <Stat label="Food" icon="🍎" value={stats.food} />
          <Stat label="Joy" icon="💖" value={stats.joy} />
          <Stat label="Energy" icon="⚡" value={stats.energy} />
        </div>

        <div className="buttons">
          <button className="round" onClick={() => doAction("feed")} disabled={stats.asleep}>
            🍎<span>Feed</span>
          </button>
          <button className="round" onClick={() => doAction("play")} disabled={stats.asleep}>
            ⚽<span>Play</span>
          </button>
          <button className="round" onClick={() => doAction(stats.asleep ? "wake" : "sleep")}>
            {stats.asleep ? "☀️" : "💤"}
            <span>{stats.asleep ? "Wake" : "Sleep"}</span>
          </button>
          <button className="round" onClick={() => say(lineFor(mood, pet.name))} disabled={stats.asleep}>
            💬<span>Talk</span>
          </button>
          <button className={`round ${mirrorOn ? "active" : ""}`} onClick={() => void toggleMirror()} disabled={glFailed}>
            🪞<span>{mirrorOn ? "Stop" : "Mirror"}</span>
          </button>
        </div>
      </div>
      {mirrorError && <p className="coach bad">{mirrorError}</p>}
      {mirrorOn && <p className="muted small center">Live mode: move your head, blink and talk — {pet.name || "your hero"} copies you (on-device, free).</p>}
      {!pet.sprite.cutout && <p className="muted small center">Background couldn't be removed cleanly — try again for a crisper cut-out.</p>}

      <div className="row center">
        <button className="btn" onClick={download}>
          ⬇️ Download PNG
        </button>
        <button
          className="btn"
          onClick={() => {
            if (confirm("Start over with a new photo? Your current pet will be replaced.")) onNewPet();
          }}
        >
          🔄 New hero
        </button>
      </div>
    </section>
  );
}

function Stat({ label, icon, value }: { label: string; icon: string; value: number }) {
  const v = Math.round(value);
  return (
    <div className="stat" title={`${label}: ${v}%`}>
      <span aria-hidden>{icon}</span>
      <div className="bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={v}>
        <div className={`fill ${v < 30 ? "low" : ""}`} style={{ width: `${v}%` }} />
      </div>
    </div>
  );
}
