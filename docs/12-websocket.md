# 12 — WebSocket (Realtime)

Realtime is a first-class product surface. The WebSocket layer delivers **position updates,
status updates, events, and notifications** to clients with sub-second latency and survives
reconnects without visible gaps. Served by `apps/api`; scaled horizontally via Redis
Pub/Sub + Streams ([09](./09-redis.md)).

## 12.1 Why WebSocket (vs SSE/polling)

- Bidirectional (client subscribes/unsubscribes to channels dynamically as the map pans or a
  flight page opens) and low-overhead for high-frequency position streams.
- SSE considered as a fallback for restrictive networks (§12.9); long-polling as last resort.

## 12.2 Connection lifecycle

```
client connects  wss://.../ws?token=<short-lived-ws-ticket>
  → server authenticates ticket (see 12.7), assigns connectionId, sends `hello`
  → client sends `subscribe` messages for channels it needs
  → server streams `event` messages for subscribed channels
  → heartbeat ping/pong keeps it alive; idle/absent pong → close
  → on close, client reconnects with backoff + last-seen cursor (12.6)
```

- One connection per tab (shared across the app via a client singleton). The connection is
  multiplexed across many logical channels.

## 12.3 Channels (subscription topics)

| Channel | Subscribed when | Payload cadence |
|---------|-----------------|-----------------|
| `viewport:<sub>` | map open; `sub` = quantized bbox/geohash | positions in view, ~1–5s |
| `flight:<flightId>` | flight page open | position + telemetry + events |
| `airport:<iata>` | airport page open | board status deltas |
| `user:<userId>` | authenticated session | notifications, dashboard deltas |
| `admin:metrics` | admin console | system metrics (throttled) |

- **Viewport subscription** sends the current bbox; server maps it to the relevant
  `rt:positions:<geohashPrefix>` Redis channels and filters to the exact bbox before sending.
- Subscriptions are **capped per connection** (e.g. ≤ 1 viewport + N flights) to bound fan-out.

## 12.4 Message protocol

All messages are JSON, Zod-validated both directions, with a discriminated `t` (type) field.
A binary/compressed encoding (MessagePack + per-message-deflate) is an optimization toggle.

### Client → Server
```
{ "t":"subscribe",   "channel":"flight:...", "cursor":"<lastEventId?>" }
{ "t":"unsubscribe", "channel":"viewport:..." }
{ "t":"viewport",    "bbox":[w,s,e,n], "zoom":6 }      // updates the viewport sub
{ "t":"ping" }
```

### Server → Client
```
{ "t":"hello", "connectionId":"...", "serverTime":"...", "heartbeatMs":15000, "resumeWindowMs":120000 }
{ "t":"ack", "channel":"flight:...", "cursor":"<latestEventId>" }
{ "t":"event", "channel":"flight:...", "id":"<streamId>", "event": <EventEnvelope> }
{ "t":"snapshot", "channel":"flight:...", "snapshotId":"...", "sequence":1, "generatedAt":"...", "scope":{"kind":"flight","flightId":"..."}, "data": <currentState> }
{ "t":"snapshot", "channel":"viewport", "snapshotId":"...", "sequence":2, "generatedAt":"...", "scope":{"kind":"viewport","bbox":[w,s,e,n]}, "data": [<currentState>] }
{ "t":"pong" }
{ "t":"error", "code":"...", "message":"..." }
{ "t":"reconnect", "reason":"server_draining" }        // ask client to reconnect (deploys)
```

- **`snapshot` first, then deltas:** on subscribe, server sends current state (from Redis hot
  state / cache) so the UI paints immediately, then streams incremental `event`s. This avoids a
  blank first frame and defines the baseline for reconciliation.
- **Viewport snapshots are authoritative for their `scope.bbox`:** the client removes local
  aircraft missing from that snapshot unless it has already received a newer event for them.
- **Event bodies reuse the domain `EventEnvelope`** ([07](./07-event-system.md) §7.2) — one schema across
  bus, WS, and clients.

### Message-type catalog (payloads)
- **position delta:** `{ flightId, lat, lon, altFt, headingDeg, gsKt, vrateFpm, onGround, ts }`
- **telemetry/flight update:** partial flight snapshot (status, ETA, distances).
- **event:** takeoff/landing/descent/gate/delay/etc. (full envelope; drives timeline + toasts).
- **notification:** `{ id, title, body, channel, flightId, url }` (dashboard feed + toast).

## 12.5 Client rendering rules

- **Interpolation:** positions arrive every 1–5s; the client **lerps** lat/lon and heading
  between samples on an animation frame so aircraft glide smoothly (see [04](./04-design-system.md) §4.8).
- **Out-of-order guard:** drop any delta with `ts` older than the last applied `ts` per flight.
- **Freshness lifecycle:** live targets can be projected briefly; stale/signal-lost targets are
  frozen at the last authoritative point and pruned after `removeAfterMs` if no recovery arrives.
- **Snapshot reconcile:** reconnect/viewport snapshots carry `snapshotId`, `generatedAt`, and
  `scope`, allowing idempotent application and safe removal of missing in-scope targets.
- **Backpressure (client):** coalesce rapid deltas to at most one apply per animation frame.
- **Live regions:** telemetry numbers update via ARIA-polite regions ([03](./03-ux.md) §3.7).

## 12.6 Reconnect strategy

1. On unexpected close, show a subtle "reconnecting" chip (non-blocking).
2. **Exponential backoff with jitter**: 0.5s → 1 → 2 → 5 → 10 → 30s cap; reset on success.
3. On reconnect, re-auth (fresh ticket), re-`subscribe` to prior channels **with the last-seen
   `cursor`** per channel.
4. Server **replays missed deltas** from the channel's Redis Stream (`XRANGE` from cursor,
   bounded by `resumeWindowMs`). If the gap exceeds the retained window, server sends a fresh
   `snapshot` instead and the client does a full reconcile.
5. UI reconciles silently — no flicker, no duplicate toasts (events deduped by envelope `id`).

- **Offline handling:** if the network is fully offline, the client pauses reconnect attempts
  until `navigator.onLine`, shows "offline", and resumes immediately on reconnection.

## 12.7 Authentication & authorization

- **Cannot** rely on cookies alone cross-origin for WS reliably → the client first calls
  `POST /api/v1/ws/ticket` (authenticated via session) to get a **short-lived signed WS ticket**
  (JWT, ~60s TTL, single-use, bound to userId + IP/UA hash). The WS handshake presents it as
  `?token=`; server verifies signature + freshness, then upgrades.
- Guests get an anonymous ticket (rate-limited, public channels only).
- **Authorization per channel:** `user:<id>` requires the ticket's `userId` to match;
  `admin:metrics` requires `role=admin`; public channels (viewport/flight/airport) allowed for
  all. Subscription requests are authorized server-side; unauthorized → `error` + no data.

## 12.8 Scaling (horizontal)

```
                clients
   ┌──────────────┼───────────────┐
 api-1          api-2           api-3     (N stateless WS nodes behind LB w/ sticky-ish)
   │   each subscribes to Redis   │
   └────────── Redis Pub/Sub + Streams ──┘
        ▲ producers publish once (tracker/worker/notifier)
```

- **Fan-out via Redis:** producers publish an event once; every `api` node that has a subscriber
  for that channel receives it via Pub/Sub and forwards to its local sockets. No node-to-node
  coupling.
- **Sharded position channels** (`rt:positions:<geohashPrefix>`) so a node only receives
  positions for regions its clients are viewing — avoids every node processing the whole world.
- **Sticky sessions** at the LB are *not required* (any node can serve any client) but help keep
  reconnects local; connection state is per-node and rebuildable from subscribe messages.
- **Connection scaling:** Bun handles many concurrent sockets per node; scale nodes on
  connection count / CPU. Presence/subscriber registries in Redis (optional) let producers skip
  publishing to channels with zero subscribers.
- **Graceful deploys:** draining node sends `{t:"reconnect", reason:"server_draining"}`; clients
  reconnect (backoff) and land on another node, replaying from cursor → zero data loss.

## 12.9 Fallbacks & limits

- **SSE fallback** (`GET /api/v1/stream/...`) for environments blocking WS; same event shapes,
  one-directional (subscriptions via query/reconnect). Long-poll as final fallback.
- **Limits:** max channels/connection, max connections/user/IP (Redis-tracked), message size
  cap, and per-connection send-rate cap to protect nodes. Abuse → `429`/close.

## 12.10 Observability

- Metrics: active connections/node, subscribe/unsubscribe rates, messages/sec by channel,
  fan-out lag (produce→client), reconnects, resume-replay counts, dropped-old deltas.
- The API metrics registry currently exposes active connections, sent WS messages by type/channel,
  reconnect subscriptions with cursors, and snapshot item counts. When a bus event is delivered to
  at least one socket, the hub marks `websocketPublishedAt` in the flight hot state for admin
  debugging.
- Each socket carries a `connectionId` + `correlationId` for tracing an event from OpenSky poll
  → bus → WS node → client (see [07](./07-event-system.md) §7.8).
