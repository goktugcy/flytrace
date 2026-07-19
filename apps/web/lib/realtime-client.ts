import { FlightStore, applyServerMessage } from './flight-store';

export type Bbox = [west: number, south: number, east: number, north: number];
export type RealtimeStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

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
  private readonly cursors = new Map<string, string>();
  private readonly listeners = new Set<(msg: unknown) => void>();
  private readonly statusListeners = new Set<(status: RealtimeStatus) => void>();
  private status: RealtimeStatus = 'disconnected';
  private generation = 0;

  constructor(private readonly opts: RealtimeOptions) {}

  async connect(): Promise<void> {
    this.closed = false;
    this.setStatus('connecting');
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
      this.sendSubscribe(channel);
    }
  }

  /** Observe every decoded server message (in addition to the flight store). */
  onMessage(fn: (msg: unknown) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  onStatus(fn: (status: RealtimeStatus) => void): () => void {
    this.statusListeners.add(fn);
    fn(this.status);
    return () => {
      this.statusListeners.delete(fn);
    };
  }

  getStatus(): RealtimeStatus {
    return this.status;
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
    this.setStatus('disconnected');
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
      this.generation += 1;
      this.store.setConnectionGeneration(this.generation);
      this.setStatus('connected');
      if (this.bbox) ws.send(JSON.stringify({ t: 'viewport', bbox: this.bbox }));
      for (const channel of this.channels) this.sendSubscribe(channel);
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string);
        this.captureCursor(msg);
        applyServerMessage(this.store, msg);
        for (const fn of this.listeners) fn(msg);
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onclose = () => {
      this.ws = null;
      if (!this.closed) {
        this.setStatus('reconnecting');
        this.scheduleReconnect();
      }
    };
    ws.onerror = () => ws.close();
  }

  private sendSubscribe(channel: string): void {
    const cursor = this.cursors.get(channel);
    this.ws?.send(
      JSON.stringify(cursor ? { t: 'subscribe', channel, cursor } : { t: 'subscribe', channel }),
    );
  }

  private captureCursor(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { t?: unknown; channel?: unknown; id?: unknown; cursor?: unknown };
    if (m.t === 'event' && typeof m.channel === 'string' && typeof m.id === 'string') {
      this.cursors.set(m.channel, m.id);
    } else if (m.t === 'ack' && typeof m.channel === 'string' && typeof m.cursor === 'string') {
      this.cursors.set(m.channel, m.cursor);
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    this.setStatus(this.status === 'disconnected' ? 'connecting' : 'reconnecting');
    const jitter = Math.floor(this.backoffMs * 0.3 * ((Date.now() % 100) / 100));
    const delay = Math.min(this.backoffMs, 30_000) + jitter;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    setTimeout(() => {
      if (!this.closed) void this.open();
    }, delay);
  }

  private setStatus(status: RealtimeStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const fn of this.statusListeners) fn(status);
  }
}
