import {
  type Clock,
  type EventEnvelope,
  type Logger,
  baseEnvelopeSchema,
  flightQualityStateSchema,
  streamKeys,
} from '@flytrace/shared';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { ApiMetrics } from '../metrics.ts';
import { type Bbox, authorizeChannel, inBbox, parseChannel } from './channels.ts';
import type { ClientMessage, ServerMessage } from './protocol.ts';
import type { TicketPayload } from './ticket.ts';

/** Transport-agnostic socket the hub talks to (Bun WS adapter implements it). */
export interface Socket {
  readonly id: string;
  send(msg: ServerMessage): void;
  close(code?: number, reason?: string): void;
}

export interface HubOptions {
  heartbeatMs: number;
  resumeWindowMs: number;
  maxFlightsPerConn: number;
  /** Cap on entries replayed per reconnect (bounds a burst). */
  replayLimit: number;
}

export const DEFAULT_HUB_OPTIONS: HubOptions = {
  heartbeatMs: 15_000,
  resumeWindowMs: 120_000,
  maxFlightsPerConn: 20,
  replayLimit: 500,
};

interface ConnState {
  socket: Socket;
  ticket: TicketPayload;
  channels: Set<string>;
  viewport: Bbox | null;
  lastSeen: number;
}

/** Minimal read-model of the tracker's hot flight state (docs/09 §9.8). */
const hotStateSchema = z
  .object({
    flightId: z.string(),
    icao24: z.string(),
    callsign: z.string().nullable(),
    lat: z.number(),
    lon: z.number(),
    altFt: z.number().nullable(),
    geoAltitudeFt: z.number().nullable().optional(),
    gsKt: z.number().nullable(),
    headingDeg: z.number().nullable(),
    vrateFpm: z.number().nullable(),
    squawk: z.string().nullable().optional(),
    category: z.string().nullish(),
    lastTs: z.string(),
    qualityState: flightQualityStateSchema.optional(),
    selectedProvider: z.string().optional(),
    sourceTimestamp: z.string().optional(),
    receivedAt: z.string().optional(),
    ageMs: z.number().optional(),
    qualityScore: z.number().optional(),
    positionSource: z.string().optional(),
    isMlat: z.boolean().optional(),
    lastAcceptedAt: z.string().optional(),
    lastQualityTransitionAt: z.string().optional(),
  })
  .passthrough();
type HotState = z.infer<typeof hotStateSchema>;

/**
 * The realtime fan-out core (docs/12). Holds per-connection subscription state
 * and routes bus events to the sockets that want them. Deliberately transport-
 * agnostic: the Bun WebSocket adapter drives it, and tests drive it with a fake
 * {@link Socket}. All Redis reads (snapshot, reconnect replay) live here.
 */
export class WsHub {
  private readonly conns = new Map<string, ConnState>();
  private readonly options: HubOptions;
  private snapshotSeq = 0;

  constructor(
    private readonly deps: {
      redis: Redis;
      prefix: string;
      clock: Clock;
      logger: Logger;
      metrics?: Pick<ApiMetrics, 'wsMessagesSent' | 'wsReconnects' | 'wsSnapshotSize'>;
    },
    options: Partial<HubOptions> = {},
  ) {
    this.options = { ...DEFAULT_HUB_OPTIONS, ...options };
  }

  get size(): number {
    return this.conns.size;
  }

  add(socket: Socket, ticket: TicketPayload): void {
    this.conns.set(socket.id, {
      socket,
      ticket,
      channels: new Set(),
      viewport: null,
      lastSeen: this.deps.clock.now(),
    });
    this.sendSocket(socket, {
      t: 'hello',
      connectionId: socket.id,
      serverTime: this.deps.clock.nowIso(),
      heartbeatMs: this.options.heartbeatMs,
      resumeWindowMs: this.options.resumeWindowMs,
    });
  }

  remove(socketId: string): void {
    this.conns.delete(socketId);
  }

  async handleMessage(socketId: string, msg: ClientMessage): Promise<void> {
    const conn = this.conns.get(socketId);
    if (!conn) return;
    conn.lastSeen = this.deps.clock.now();

    switch (msg.t) {
      case 'ping':
        this.sendSocket(conn.socket, { t: 'pong' });
        return;
      case 'subscribe':
        await this.onSubscribe(conn, msg.channel, msg.cursor);
        return;
      case 'unsubscribe':
        conn.channels.delete(msg.channel);
        return;
      case 'viewport':
        conn.viewport = msg.bbox;
        await this.sendViewportSnapshot(conn);
        return;
    }
  }

  private async onSubscribe(conn: ConnState, raw: string, cursor?: string): Promise<void> {
    const channel = parseChannel(raw);
    if (!channel) {
      this.sendSocket(conn.socket, {
        t: 'error',
        code: 'BAD_CHANNEL',
        message: `unknown channel: ${raw}`,
      });
      return;
    }
    if (!authorizeChannel(channel, conn.ticket)) {
      this.sendSocket(conn.socket, {
        t: 'error',
        code: 'FORBIDDEN',
        message: `not allowed: ${raw}`,
      });
      return;
    }
    if (channel.kind === 'flight' && this.countFlights(conn) >= this.options.maxFlightsPerConn) {
      this.sendSocket(conn.socket, {
        t: 'error',
        code: 'LIMIT',
        message: 'too many flight subscriptions',
      });
      return;
    }

    conn.channels.add(channel.raw);
    if (cursor) this.deps.metrics?.wsReconnects.inc({ channel: channel.kind });

    if (channel.kind === 'flight') {
      await this.sendFlightSnapshot(conn, channel.flightId, channel.raw);
      if (cursor) await this.replayFlight(conn, channel.flightId, channel.raw, cursor);
      const latest = await this.latestStreamId(streamKeys.flight(channel.flightId));
      this.sendSocket(conn.socket, { t: 'ack', channel: channel.raw, cursor: latest }, channel.raw);
    } else {
      this.sendSocket(conn.socket, { t: 'ack', channel: channel.raw, cursor: null }, channel.raw);
    }
  }

  /** Route a bus event (with its per-flight stream id) to interested sockets. */
  route(sid: string, event: EventEnvelope): void {
    const flightChannel = `flight:${event.partitionKey}`;
    const isPosition = event.type === 'PositionUpdated';
    const isViewportLifecycle = VIEWPORT_LIFECYCLE_EVENTS.has(event.type);
    const pos = isPosition ? positionOf(event) : null;
    let delivered = false;

    for (const conn of this.conns.values()) {
      if (conn.channels.has(flightChannel)) {
        this.sendSocket(
          conn.socket,
          { t: 'event', channel: flightChannel, id: sid, event },
          flightChannel,
        );
        delivered = true;
      }
      if (conn.viewport && pos && inBbox(pos.lat, pos.lon, conn.viewport)) {
        this.sendSocket(
          conn.socket,
          { t: 'event', channel: 'viewport', id: sid, event },
          'viewport',
        );
        delivered = true;
      } else if (conn.viewport && isViewportLifecycle) {
        this.sendSocket(
          conn.socket,
          { t: 'event', channel: 'viewport', id: sid, event },
          'viewport',
        );
        delivered = true;
      }
    }
    if (delivered) void this.markWebsocketPublished(event);
  }

  // ── snapshots & replay ──

  private async sendFlightSnapshot(
    conn: ConnState,
    flightId: string,
    channel: string,
  ): Promise<void> {
    const state = await this.readHotState(flightId);
    this.sendSocket(
      conn.socket,
      this.snapshotMessage(conn, channel, { kind: 'flight', flightId }, state),
      channel,
    );
  }

  private async sendViewportSnapshot(conn: ConnState): Promise<void> {
    if (!conn.viewport) return;
    const ids = await this.deps.redis.smembers(`${this.deps.prefix}flights:active`);
    if (ids.length === 0) {
      this.sendSocket(
        conn.socket,
        this.snapshotMessage(
          conn,
          'viewport',
          {
            kind: 'viewport',
            bbox: [...conn.viewport] as [number, number, number, number],
          },
          [],
        ),
        'viewport',
      );
      return;
    }
    const raws = await this.deps.redis.mget(ids.map((id) => this.stateKey(id)));
    const inView: HotState[] = [];
    for (const raw of raws) {
      if (!raw) continue;
      const parsed = hotStateSchema.safeParse(safeJson(raw));
      if (parsed.success && inBbox(parsed.data.lat, parsed.data.lon, conn.viewport)) {
        inView.push(parsed.data);
      }
    }
    this.sendSocket(
      conn.socket,
      this.snapshotMessage(
        conn,
        'viewport',
        {
          kind: 'viewport',
          bbox: [...conn.viewport] as [number, number, number, number],
        },
        inView,
      ),
      'viewport',
    );
  }

  private async replayFlight(
    conn: ConnState,
    flightId: string,
    channel: string,
    cursor: string,
  ): Promise<void> {
    // XRANGE (exclusive from cursor) → replay missed deltas (docs/12 §12.6).
    const entries = (await this.deps.redis.xrange(
      `${this.deps.prefix}${streamKeys.flight(flightId)}`,
      `(${cursor}`,
      '+',
      'COUNT',
      this.options.replayLimit,
    )) as [string, string[]][];

    for (const [id, fields] of entries) {
      const body = fieldValue(fields, 'e');
      if (!body) continue;
      const parsed = baseEnvelopeSchema.safeParse(safeJson(body));
      if (parsed.success) {
        this.sendSocket(
          conn.socket,
          { t: 'event', channel, id, event: parsed.data as EventEnvelope },
          channel,
        );
      }
    }
  }

  private async readHotState(flightId: string): Promise<HotState | null> {
    const raw = await this.deps.redis.get(this.stateKey(flightId));
    if (!raw) return null;
    const parsed = hotStateSchema.safeParse(safeJson(raw));
    return parsed.success ? parsed.data : null;
  }

  private async latestStreamId(streamSuffix: string): Promise<string | null> {
    const last = (await this.deps.redis.xrevrange(
      `${this.deps.prefix}${streamSuffix}`,
      '+',
      '-',
      'COUNT',
      1,
    )) as [string, string[]][];
    return last[0]?.[0] ?? null;
  }

  private stateKey(flightId: string): string {
    return `${this.deps.prefix}flight:state:${flightId}`;
  }

  private countFlights(conn: ConnState): number {
    let n = 0;
    for (const c of conn.channels) if (c.startsWith('flight:')) n += 1;
    return n;
  }

  private snapshotMessage(
    conn: ConnState,
    channel: string,
    scope: Extract<ServerMessage, { t: 'snapshot' }>['scope'],
    data: unknown,
  ): Extract<ServerMessage, { t: 'snapshot' }> {
    const sequence = ++this.snapshotSeq;
    return {
      t: 'snapshot',
      channel,
      snapshotId: `${conn.socket.id}:${sequence}`,
      sequence,
      generatedAt: this.deps.clock.nowIso(),
      scope,
      data,
    };
  }

  private sendSocket(socket: Socket, msg: ServerMessage, channel = 'control'): void {
    this.deps.metrics?.wsMessagesSent.inc({ type: msg.t, channel: metricChannel(channel) });
    if (msg.t === 'snapshot') {
      const size = Array.isArray(msg.data) ? msg.data.length : msg.data === null ? 0 : 1;
      this.deps.metrics?.wsSnapshotSize.observe(size, {
        channel: metricChannel(msg.channel),
        scope: msg.scope.kind,
      });
    }
    socket.send(msg);
  }

  private async markWebsocketPublished(event: EventEnvelope): Promise<void> {
    const flightId =
      typeof (event.payload as { flightId?: unknown }).flightId === 'string'
        ? (event.payload as { flightId: string }).flightId
        : event.partitionKey;
    if (!flightId) return;
    try {
      await this.deps.redis.eval(
        MARK_WS_PUBLISHED_LUA,
        1,
        this.stateKey(flightId),
        this.deps.clock.nowIso(),
      );
    } catch (err) {
      this.deps.logger.warn('ws debug publish marker failed', {
        flightId,
        err: String(err),
      });
    }
  }
}

const MARK_WS_PUBLISHED_LUA = `
local raw = redis.call('get', KEYS[1])
if not raw then return 0 end
local state = cjson.decode(raw)
state['websocketPublishedAt'] = ARGV[1]
redis.call('set', KEYS[1], cjson.encode(state), 'KEEPTTL')
return 1
`;

const VIEWPORT_LIFECYCLE_EVENTS = new Set([
  'FlightDelayed',
  'FlightStale',
  'FlightSignalLost',
  'FlightRecovered',
  'FlightEnded',
]);

function positionOf(event: EventEnvelope): { lat: number; lon: number } | null {
  const p = event.payload as { lat?: unknown; lon?: unknown };
  return typeof p?.lat === 'number' && typeof p?.lon === 'number'
    ? { lat: p.lat, lon: p.lon }
    : null;
}

function fieldValue(fields: string[], key: string): string | null {
  for (let i = 0; i < fields.length - 1; i += 2)
    if (fields[i] === key) return fields[i + 1] ?? null;
  return null;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function metricChannel(channel: string): string {
  const i = channel.indexOf(':');
  return i === -1 ? channel : channel.slice(0, i);
}
