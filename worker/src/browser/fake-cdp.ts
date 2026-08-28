// ===========================================================================
// A scriptable in-memory CDP transport for unit tests (build P3.4). This is
// how BRW-01/03/05/08 are code-asserted with NO real Chromium: the harness is
// fully exercised against fakes, exactly as the task requires ("CDP layer
// behind an injectable transport").
//
// It is test support that ships in src/ so both the browser tests and the
// integration test can import it; it makes no network or process calls.
// ===========================================================================

import type { RawCdpTransport } from "./cdp.js";

export type CommandResponder = (
  method: string,
  params: Record<string, unknown>,
  sessionId: string | undefined,
) => Record<string, unknown>;

export class FakeCdpTransport implements RawCdpTransport {
  private messageHandler: ((m: string) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private closed = false;
  /** Every command the harness sent, for assertions (BRW-03/05). */
  readonly sent: { method: string; params: Record<string, unknown>; sessionId?: string }[] =
    [];

  constructor(private readonly responder: CommandResponder) {}

  send(message: string): void {
    const msg = JSON.parse(message) as {
      id: number;
      method: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    };
    this.sent.push({
      method: msg.method,
      params: msg.params ?? {},
      sessionId: msg.sessionId,
    });
    let result: Record<string, unknown>;
    try {
      result = this.responder(msg.method, msg.params ?? {}, msg.sessionId);
    } catch (err) {
      queueMicrotask(() =>
        this.deliver({
          id: msg.id,
          error: { code: -32000, message: (err as Error).message },
        }),
      );
      return;
    }
    queueMicrotask(() => this.deliver({ id: msg.id, result }));
  }

  /** Push a CDP event to the client (navigation loads, etc.). */
  emit(method: string, params: Record<string, unknown>, sessionId?: string): void {
    this.deliver({ method, params, sessionId });
  }

  private deliver(obj: unknown): void {
    if (this.closed) return;
    this.messageHandler?.(JSON.stringify(obj));
  }

  onMessage(handler: (m: string) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    this.closed = true;
    this.closeHandler?.();
  }
}

/**
 * A responder pre-wired for the harness: it answers every command the harness
 * issues and, on Page.navigate, emits Page.loadEventFired for that session and
 * records the URL so a later Runtime.evaluate page-sample reflects it. The
 * per-URL page bodies drive the challenge/login classifier in tests.
 */
export function makeHarnessResponder(pages: Record<string, {
  title?: string;
  bodyText?: string;
  hasPasswordField?: boolean;
  axNodes?: unknown[];
  attributesByBackendId?: Record<number, string[]>;
}>): { responder: CommandResponder; setTransport: (t: FakeCdpTransport) => void; currentUrl: () => string } {
  let transport: FakeCdpTransport | null = null;
  const sessionUrl = new Map<string, string>();
  let nextTarget = 1;
  let nextSession = 1;
  let last = "about:blank";

  const responder: CommandResponder = (method, params, sessionId) => {
    switch (method) {
      case "Target.getTargets":
        return { targetInfos: [] };
      case "Target.createTarget": {
        const targetId = `T${nextTarget++}`;
        return { targetId };
      }
      case "Target.attachToTarget": {
        const s = `S${nextSession++}`;
        return { sessionId: s };
      }
      case "Target.closeTarget":
      case "Target.activateTarget":
      case "Page.enable":
      case "Runtime.enable":
      case "Network.enable":
      case "DOM.focus":
      case "DOM.scrollIntoViewIfNeeded":
      case "Input.dispatchMouseEvent":
      case "Input.insertText":
        return {};
      case "Page.navigate": {
        const url = String(params.url ?? "");
        last = url;
        if (sessionId) sessionUrl.set(sessionId, url);
        queueMicrotask(() =>
          transport?.emit("Page.loadEventFired", { timestamp: 1 }, sessionId),
        );
        return { frameId: "F1" };
      }
      case "Runtime.evaluate": {
        const url = (sessionId && sessionUrl.get(sessionId)) || last;
        const page = pages[url] ?? {};
        const expr = String(params.expression ?? "");
        if (expr.startsWith("fetch(")) {
          return { result: { value: page.bodyText ?? "REPLAY_BODY" } };
        }
        return {
          result: {
            value: {
              url,
              title: page.title ?? "",
              bodyText: page.bodyText ?? "",
              hasPasswordField: page.hasPasswordField === true,
            },
          },
        };
      }
      case "Accessibility.getFullAXTree": {
        const url = (sessionId && sessionUrl.get(sessionId)) || last;
        return { nodes: pages[url]?.axNodes ?? [] };
      }
      case "DOM.describeNode": {
        const url = (sessionId && sessionUrl.get(sessionId)) || last;
        const backendId = Number(params.backendNodeId);
        const attrs = pages[url]?.attributesByBackendId?.[backendId] ?? [];
        return { node: { attributes: attrs } };
      }
      case "DOM.getBoxModel":
        return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
      default:
        return {};
    }
  };

  return {
    responder,
    setTransport: (t) => (transport = t),
    currentUrl: () => last,
  };
}
