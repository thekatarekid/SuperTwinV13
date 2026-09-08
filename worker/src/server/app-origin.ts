import type { IncomingMessage } from "node:http";

export function isTrustedAppOrigin(origin: string): boolean {
  if (origin === "tauri://localhost") return true;
  if (process.env.NODE_ENV !== "development") return false;
  return origin === (process.env.SUPERTWIN_DEV_ORIGIN ?? "http://localhost:1420");
}

/** Native clients omit Origin; browser callers must be the local app. */
export function requireTrustedMutationOrigin(req: IncomingMessage): void {
  const raw = req.headers?.origin;
  if (raw === undefined) return;
  if (Array.isArray(raw) || !isTrustedAppOrigin(raw)) {
    const error = new Error("untrusted request origin") as Error & { code?: string };
    error.code = "BAD_REQUEST";
    throw error;
  }
}
