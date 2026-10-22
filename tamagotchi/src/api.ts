import type { Selection } from "../shared/options.ts";

export interface Health {
  provider: "pollinations" | "gemini" | "local" | "mock";
  label: string;
  demo: boolean;
  local?: boolean;
}

export interface MascotResponse {
  image: string;
  provider: string;
  model: string;
  name: string;
  ms: number;
}

export async function getHealth(): Promise<Health> {
  const res = await fetch("/api/health");
  if (!res.ok) throw new Error("The local server isn't running. Start it with `npm run dev`.");
  return res.json();
}

export async function createMascot(photo: string, options: Selection, name: string, signal?: AbortSignal): Promise<MascotResponse> {
  let res: Response;
  try {
    res = await fetch("/api/mascot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photo, options, name }),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new Error("Couldn't reach the local server. Is `npm run dev` still running?");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as MascotResponse;
}
