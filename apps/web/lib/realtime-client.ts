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
    };
    ws.onmessage = (ev) => {
      try {
        applyServerMessage(this.store, JSON.parse(ev.data as string));
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
