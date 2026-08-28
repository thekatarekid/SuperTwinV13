// ===========================================================================
// CDP client — build P3.4, spec §12.1/§12.4. The wire layer of the SuperTwin
// Browser: request/response correlation, session routing and event fan-out
// over an INJECTABLE raw transport.
//
// The transport is one interface (`RawCdpTransport`) with two real
// implementations: the Chromium `--remote-debugging-pipe` framing
// (chromium.ts) in production, and in-memory fakes in unit tests — which is
// how BRW-01/03/05/08 are code-asserted without a Chromium on the machine.
// ===========================================================================

/** One direction of the raw wire: JSON strings in, JSON strings out. */
export interface RawCdpTransport {
  send(message: string): void;
  onMessage(handler: (message: string) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

interface Pending {
  resolve: (result: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  method: string;
}

export class CdpError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
  ) {
    super(`${method}: ${message} (CDP ${code})`);
    this.name = "CdpError";
  }
}

export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<(ev: CdpEvent) => void>>();
  private closed = false;

  constructor(private readonly transport: RawCdpTransport) {
    transport.onMessage((raw) => this.dispatch(raw));
    transport.onClose(() => this.handleClose());
  }

  /**
   * Send one command; `sessionId` routes it to an attached target (flat
   * session mode — Target.attachToTarget with flatten:true).
   */
  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    if (this.closed) {
      return Promise.reject(new Error(`CDP connection closed (sending ${method})`));
    }
    const id = this.nextId++;
    const msg: Record<string, unknown> = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.transport.send(JSON.stringify(msg));
    });
  }

  /** Subscribe to a CDP event by method name. Returns an unsubscribe. */
  on(method: string, handler: (ev: CdpEvent) => void): () => void {
    let set = this.listeners.get(method);
    if (!set) {
      set = new Set();
      this.listeners.set(method, set);
    }
    set.add(handler);
    return () => set?.delete(handler);
  }

  /** Resolve when `method` fires and `match` accepts it (default: any). */
  waitFor(
    method: string,
    match: (ev: CdpEvent) => boolean = () => true,
    timeoutMs = 15_000,
  ): Promise<CdpEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timed out waiting for ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      const off = this.on(method, (ev) => {
        if (!match(ev)) return;
        clearTimeout(timer);
        off();
        resolve(ev);
      });
    });
  }

  close(): void {
    this.transport.close();
    this.handleClose();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private dispatch(raw: string): void {
    let msg: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
      result?: Record<string, unknown>;
      error?: { code: number; message: string };
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // a torn frame is dropped, not fatal — the pipe framing dedups
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        p.reject(new CdpError(p.method, msg.error.code, msg.error.message));
      } else {
        p.resolve(msg.result ?? {});
      }
      return;
    }
    if (typeof msg.method === "string") {
      const ev: CdpEvent = {
        method: msg.method,
        params: msg.params ?? {},
        sessionId: msg.sessionId,
      };
      for (const handler of this.listeners.get(msg.method) ?? []) {
        handler(ev);
      }
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      p.reject(new Error(`CDP connection closed (awaiting ${p.method})`));
    }
    this.pending.clear();
  }
}
