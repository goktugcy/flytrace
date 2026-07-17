import { correlationId } from '@flytrace/shared';
import type { Server, ServerWebSocket, WebSocketHandler } from 'bun';
import type { AppContext } from '../context.ts';
import { RedisFanout } from './fanout.ts';
import { type HubOptions, WsHub } from './hub.ts';
import type { Socket } from './hub.ts';
import { parseClientMessage } from './protocol.ts';
import { type TicketPayload, verifyTicket } from './ticket.ts';

interface WsData {
  ticket: TicketPayload;
  connId: string;
  socket?: Socket;
}

/** Adapts a Bun {@link ServerWebSocket} to the hub's {@link Socket} port. */
class BunSocket implements Socket {
  constructor(
    readonly id: string,
    private readonly ws: ServerWebSocket<WsData>,
  ) {}
  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }
  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }
}

/**
 * The WebSocket edge for `apps/api` (docs/12): validates the handshake ticket,
 * upgrades the connection, and pumps client messages into the {@link WsHub}
 * while {@link RedisFanout} pushes bus events out. Heartbeat is client-driven
 * (`ping`/`pong`) with Bun's idle timeout as the dead-connection backstop.
 */
export class WsGateway {
  readonly hub: WsHub;
  private readonly fanout: RedisFanout;

  constructor(
    private readonly ctx: AppContext,
    hubOptions: Partial<HubOptions> = {},
  ) {
    this.hub = new WsHub(
      { redis: ctx.redis, prefix: ctx.redisPrefix, clock: ctx.clock, logger: ctx.logger },
      hubOptions,
    );
    this.fanout = new RedisFanout(ctx.redis, ctx.redisPrefix, this.hub, ctx.logger);
  }

  start(): Promise<void> {
    return this.fanout.start();
  }
  stop(): Promise<void> {
    return this.fanout.stop();
  }

  /** Handle the `/ws` upgrade request. Returns a rejection Response, or upgrades. */
  async handleUpgrade(req: Request, server: Server<WsData>): Promise<Response | undefined> {
    const token = new URL(req.url).searchParams.get('token');
    if (!token) return unauthorized('missing ticket');

    const ticket = await verifyTicket(token, this.ctx.config.AUTH_SECRET, this.ctx.clock.now());
    if (!ticket) return unauthorized('invalid or expired ticket');

    // Single-use: consume the jti so a stolen ticket can't be replayed.
    const ttl = Math.max(1000, ticket.exp - this.ctx.clock.now());
    const fresh = await this.ctx.redis.set(
      `${this.ctx.redisPrefix}idem:wsjti:${ticket.jti}`,
      '1',
      'PX',
      ttl,
      'NX',
    );
    if (fresh !== 'OK') return unauthorized('ticket already used');

    const data: WsData = { ticket, connId: correlationId() };
    const ok = server.upgrade(req, { data });
    return ok ? undefined : unauthorized('upgrade failed');
  }

  get websocket(): WebSocketHandler<WsData> {
    return {
      open: (ws) => {
        const socket = new BunSocket(ws.data.connId, ws);
        ws.data.socket = socket;
        this.hub.add(socket, ws.data.ticket);
        this.ctx.metrics?.wsConnections.set(this.hub.size);
      },
      message: (ws, raw) => {
        const msg = parseClientMessage(typeof raw === 'string' ? raw : raw.toString());
        if (!msg) {
          ws.data.socket?.send({ t: 'error', code: 'BAD_MESSAGE', message: 'unparseable' });
          return;
        }
        void this.hub.handleMessage(ws.data.connId, msg);
      },
      close: (ws) => {
        this.hub.remove(ws.data.connId);
        this.ctx.metrics?.wsConnections.set(this.hub.size);
      },
    };
  }
}

function unauthorized(message: string): Response {
  return new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message } }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });
}
