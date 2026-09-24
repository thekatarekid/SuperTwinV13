// Free, on-device voice via the browser's Web Speech API. While the pet talks
// we drive the puppet's mouth: word boundaries open it wide, and it flaps in
// between so every voice engine looks alive (some fire no boundary events).

export function canSpeak(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

function pickVoice(): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  const en = voices.filter((v) => v.lang.toLowerCase().startsWith("en"));
  const pool = en.length ? en : voices;
  return (
    pool.find((v) => /samantha|google us english|aria|jenny|zira|karen/i.test(v.name)) ?? pool.find((v) => v.localService) ?? pool[0]
  );
}

/** Speaks `text`; calls onLevel(0..1) every frame while speaking. */
export function speak(text: string, onLevel: (level: number) => void): () => void {
  if (!canSpeak()) return () => {};
  const synth = window.speechSynthesis;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.voice = pickVoice() ?? null;
  u.pitch = 1.6; // cute
  u.rate = 1.05;
  let speaking = true;
  let burst = 0;
  let raf = 0;
  const loop = () => {
    if (!speaking) return;
    const t = performance.now() / 1000;
    burst = Math.max(0, burst - 0.06);
    onLevel(Math.min(1, 0.25 + 0.35 * Math.abs(Math.sin(t * 17)) + burst));
    raf = requestAnimationFrame(loop);
  };
  u.onstart = () => {
    raf = requestAnimationFrame(loop);
  };
  u.onboundary = () => {
    burst = 0.45;
  };
  const end = () => {
    speaking = false;
    cancelAnimationFrame(raf);
    onLevel(0);
  };
  u.onend = end;
  u.onerror = end;
  synth.speak(u);
  return () => {
    synth.cancel();
    end();
  };
}
