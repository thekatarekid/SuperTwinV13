// [CODE] The one way a surface talks to the worker — build item 2.7.
//
// Extracted so the Episodes (§14.3) and Threads (§14.4) clients do not each
// grow their own fetch wrapper. Three rules, all of them boring on purpose:
//
//  1. A NON-2xx IS AN ERROR, NAMED. `GET /api/episodes → 500` is a message a
//     surface can render; a silently-empty page is not.
//  2. NOTHING IS COERCED. The body is handed back as the caller's type and the
//     caller decides what a wrong shape means (see `assertSessionsPage` in
//     surfaces-client.ts for what that looks like).
//  3. EVERY READ TAKES AN AbortSignal. Filter changes cancel their own fetch.

import { workerUrl } from "./config";

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(workerUrl(path), {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export async function sendJson<T>(
  method: "POST" | "PUT",
  path: string,
  body: unknown,
): Promise<T> {
  const res = await fetch(workerUrl(path), {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** Query string from a sparse bag; empty and nullish values are dropped. */
export function qs(params: Record<string, string | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, value);
  }
  const out = search.toString();
  return out ? `?${out}` : "";
}

/** An id going into a path segment. Ids are opaque; they are never trusted raw. */
export const pathId = (v: string): string => encodeURIComponent(v);
