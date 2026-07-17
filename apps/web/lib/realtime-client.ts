import { FlightStore, applyServerMessage } from './flight-store';

export type Bbox = [west: number, south: number, east: number, north: number];

export interface RealtimeOptions {
  apiBase: string; // e.g. http://localhost:3001
  wsBase: string; // e.g. ws://localhost:3001
}

/**
 * Browser realtime client (docs/12 §12.2/§12.6): fetches a WS ticket, connects,
 * subscribes to the current viewport, and feeds messages into a {@link
 * FlightStore}. Reconnects with exponential backoff + jitter and resumes the
 * viewport subscription. The pure store is unit-tested; this class is the thin
 * browser wiring around it.
 */
export class RealtimeClient {
  readonly store = new FlightStore();
  private ws: WebSocket | null = null;
  private bbox: Bbox | null = null;
  private backoffMs = 500;
  private closed = false;
  private readonly channels = new Set<string>();
  private readonly listeners = new Set<(msg: unknown) => void>();

  constructor(private readonly opts: RealtimeOptions) {}

  async connect(): Promise<void> {
    this.closed = false;
    await this.open();
  }

  setViewport(bbox: Bbox): void {
    this.bbox = bbox;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: 'viewport', bbox }));
    }
  }

  /** Subscribe to a channel (e.g. `flight:<id>`); resent on reconnect. */
  subscribe(channel: string): void {
    this.channels.add(channel);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: 'subscribe', channel }));
    }
  }

  /** Observe every decoded server message (in addition to the flight store). */
  onMessage(fn: (msg: unknown) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }

  private async open(): Promise<void> {
    let token: string;
    try {
      const res = await fetch(`${this.opts.apiBase}/api/v1/ws/ticket`, { method: 'POST' });
      token = ((await res.json()) as { data: { token: string } }).data.token;
    } catch {
      this.scheduleReconnect();
      return;
    }

    const ws = new WebSocket(`${this.opts.wsBase}/ws?token=${encodeURIComponent(token)}`);
    this.ws = ws;

    ws.onopen = () => {
      this.backoffMs = 500;
      if (this.bbox) ws.send(JSON.stringify({ t: 'viewport', bbox: this.bbox }));
      for (const channel of this.channels) ws.send(JSON.stringify({ t: 'subscribe', channel }));
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string);
        applyServerMessage(this.store, msg);
        for (const fn of this.listeners) fn(msg);
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onclose = () => {
      this.ws = null;
      if (!this.closed) this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect(): void {
    const jitter = Math.floor(this.backoffMs * 0.3 * ((Date.now() % 100) / 100));
    const delay = Math.min(this.backoffMs, 30_000) + jitter;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    setTimeout(() => {
      if (!this.closed) void this.open();
    }, delay);
  }
}
