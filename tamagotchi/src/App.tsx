import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_SELECTION, type Selection } from "../shared/options.ts";
import { createMascot, getHealth, type Health } from "./api.ts";
import { makeSprite } from "./mascot/process.ts";
import { newStats, type PetStats } from "./pet/state.ts";
import { deletePet, loadPet, savePet, type SavedPet } from "./storage.ts";
import { Capture } from "./ui/Capture.tsx";
import { Creating } from "./ui/Creating.tsx";
import { Customize } from "./ui/Customize.tsx";
import { Pet } from "./ui/Pet.tsx";

type Screen = "loading" | "capture" | "customize" | "creating" | "pet";

export function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [health, setHealth] = useState<Health | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [photo, setPhoto] = useState<string | null>(null); // memory only, never persisted
  const [selection, setSelection] = useState<Selection>(DEFAULT_SELECTION);
  const [name, setName] = useState("");
  const [pet, setPet] = useState<SavedPet | null>(null);
  const [fresh, setFresh] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    getHealth()
      .then(setHealth)
      .catch((e: Error) => setServerError(e.message));
    loadPet().then((saved) => {
      if (saved) {
        setPet(saved);
        setSelection(saved.selection);
        setName(saved.name);
        setScreen("pet");
      } else setScreen("capture");
    });
  }, []);

  const create = useCallback(async () => {
    if (!photo) return setScreen("capture");
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setCreateError(null);
    setScreen("creating");
    try {
      const res = await createMascot(photo, selection, name, ctrl.signal);
      const sprite = await makeSprite(res.image);
      if (ctrl.signal.aborted) return;
      const next: SavedPet = {
        name: res.name,
        selection,
        sprite,
        stats: pet?.stats ?? newStats(Date.now()), // regenerating keeps the pet's progress
        createdAt: Date.now(),
        provider: `${res.provider}:${res.model}`,
      };
      await savePet(next);
      setPet(next);
      setFresh(true);
      setScreen("pet");
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setCreateError((e as Error).message);
    }
  }, [photo, selection, name, pet?.stats]);

  const onStats = useCallback((stats: PetStats) => {
    setPet((p) => {
      if (!p) return p;
      const next = { ...p, stats };
      void savePet(next);
      return next;
    });
  }, []);

  return (
    <div className="app">
      <header>
        <h1>
          <span aria-hidden>🦸</span> Herogotchi
        </h1>
        <p className="tagline">Your face. Super-powered. Needs snacks.</p>
        {health?.demo && <span className="badge">Demo mode</span>}
        {health?.local && <span className="badge free">Free · runs on this Mac</span>}
      </header>
      {serverError && <p className="notice">{serverError}</p>}

      <main>
        {screen === "loading" && <p className="muted center">Loading…</p>}
        {screen === "capture" && (
          <Capture
            onPhoto={(p) => {
              setPhoto(p);
              setScreen("customize");
            }}
          />
        )}
        {screen === "customize" && photo && (
          <Customize
            photo={photo}
            selection={selection}
            name={name}
            demo={health?.demo ?? true}
            local={health?.local ?? false}
            providerLabel={health?.label ?? "the image service"}
            onChange={setSelection}
            onName={setName}
            onRetake={() => setScreen("capture")}
            onCreate={() => void create()}
          />
        )}
        {screen === "creating" && photo && (
          <Creating
            photo={photo}
            error={createError}
            local={health?.local ?? false}
            onRetry={() => void create()}
            onBack={() => {
              abort.current?.abort();
              setScreen("customize");
            }}
          />
        )}
        {screen === "pet" && pet && (
          <Pet
            key={pet.createdAt}
            pet={pet}
            fresh={fresh && !!photo}
            onStats={onStats}
            onKeep={() => setFresh(false)}
            onRegenerate={() => (photo ? void create() : setScreen("capture"))}
            onNewPet={() => {
              void deletePet();
              setPet(null);
              setFresh(false);
              setPhoto(null);
              setScreen("capture");
            }}
          />
        )}
      </main>
      <footer className="muted small">Face detection and animation run on your device.{" "}
        {health?.local ? "Your hero is drawn on this Mac too — nothing is uploaded." : "Only the cropped photo is sent, once, to draw your hero."}</footer>
    </div>
  );
}
