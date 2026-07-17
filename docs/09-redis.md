# 09 — Redis

Redis is the platform's **realtime nervous system**: cache, message broker, hot state store,
queue backend, rate limiter, and lock manager. It is **never the source of truth** — durable
state is Postgres ([05](./05-database.md)). On Redis loss, state is rebuilt from DB + next poll.

## 9.1 Why Redis (and how it's deployed)

- Single low-latency store covering many needs → fewer moving parts for a monolith.
- **Deployment:** one Redis (Compose) in dev; managed Redis / Redis Cluster or Sentinel in
  prod for HA. Pub/Sub + Streams + BullMQ + cache can share one instance early; split into
  logical instances (or Cluster with hash tags) as load grows (see §9.10).
- Clients: `ioredis` (or Bun-native) with separate connections for pub/sub vs commands
  (pub/sub connections can't run normal commands).

## 9.2 Keyspace conventions

- Namespaced, colon-delimited, lowercase: `flytrace:<domain>:<entity>:<id>[:<field>]`.
- Env prefix (`flytrace:prod:` / `flytrace:stg:`) to allow shared instances.
- TTLs explicit on every ephemeral key; no unbounded keys.
- Hash-tags `{flightId}` on related keys when Cluster is used, so a flight's keys colocate.

## 9.3 Usage 1 — Cache (read-through)

| Cache | Key | Value | TTL | Invalidation |
|-------|-----|-------|-----|--------------|
| Provider status | `cache:provider:<provider>:<flightNo>:<date>` | normalized JSON | 30–120s | on `ProviderUpdated` |
| Flight summary | `cache:flight:<flightId>` | denormalized card JSON | 15s | on `FlightUpdated` |
| Airport board | `cache:airport:<iata>:<dep|arr>` | list JSON | 30s | on relevant status change |
| Search results | `cache:search:<hash>` | ids JSON | 60s | TTL only |
| Aircraft/airline/airport catalog | `cache:catalog:<type>:<id>` | JSON | 1h | on catalog update |
| Session/user (hot) | `cache:user:<id>` | minimal profile | 5m | on profile change |

- **Pattern:** read-through with single-flight coalescing (a lock per key prevents cache
  stampede). **Negative caching** for known-missing (short TTL) to protect providers.
- Layered with DB `provider_cache` (cold backing) — see [08](./08-providers.md) §8.8.

## 9.4 Usage 2 — Pub/Sub (realtime fan-out)

- **Purpose:** push transient realtime updates from producers (`tracker`, `worker`) to all
  `apps/api` instances, which fan out to WebSocket clients ([12](./12-websocket.md)).
- **Channels:** `rt:positions:<geohashPrefix>` (viewport sharded), `rt:flight:<flightId>`,
  `rt:notifications:<userId>`, `rt:admin:metrics`.
- **Delivery:** at-most-once (fine for positions — the next sample supersedes). **Not** used for
  anything whose loss is a bug.
- **Scaling WS:** every `api` node subscribes to the channels its connected clients need;
  Redis Pub/Sub is the cross-node bus so a client on node A sees updates produced anywhere.

## 9.5 Usage 3 — Streams (durable event bus + reconnect replay)

- **Purpose:** durable, ordered, replayable event log for (a) cross-module domain events that
  must not be lost, and (b) **WebSocket reconnect backfill**.
- **Streams:** `stream:flight:<flightId>` (recent deltas, capped `MAXLEN ~ 500`), `stream:events`
  (domain events), consumed via **consumer groups** (`XREADGROUP`) for at-least-once with acks.
- **Reconnect:** client stores last event `id`; on resume, server `XRANGE`s the flight/viewport
  stream from that id → replays missed deltas → client reconciles (see [12](./12-websocket.md) §reconnect).
- **Retention:** capped length + time; long-term truth is Postgres.

## 9.6 Usage 4 — Event bus wiring (pub/sub + streams together)

- The **transactional outbox** relay ([07](./07-event-system.md) §7.1) reads unpublished rows and
  publishes each event to **both** the Stream (durable, for consumer groups + replay) and
  Pub/Sub (instant fan-out). Consumers that must not miss events use the consumer group; the WS
  gateway uses pub/sub for latency and streams for reconnect gap-fill.
- A thin `EventBus` port (`publish`, `subscribe`, `readFrom`) abstracts this so business code
  is transport-agnostic and swappable in tests.

## 9.7 Usage 5 — BullMQ (job queues)

Backed by Redis; each queue is a Redis keyspace. Queues + purpose + concurrency + retry:

| Queue | Producer | Consumer | Concurrency | Retry | DLQ |
|-------|----------|----------|-------------|-------|-----|
| `persist.positions` | tracker | worker | high (batched) | 3× exp | `persist.dlq` |
| `enrich.flight` | tracker/worker | worker | medium | 5× exp | `enrich.dlq` |
| `provider.fetch` | worker (repeatable) | worker | limited by rate budget | 5× exp+jitter | `provider.dlq` |
| `notify.send` | notifier | notifier | per-channel | 5× exp+jitter | `notify.dlq` |
| `rollup.track` | scheduler | worker | low | 3× | — |
| `maintenance` (retention, sweeps) | scheduler | worker | 1 | 2× | — |

- **Repeatable jobs** drive provider polling cadence and maintenance.
- **Flows (parent/child)** for multi-step pipelines (enrich → then schedule provider fetch).
- **Rate-limited queues** (`provider.fetch`) use BullMQ's limiter + a shared Redis token bucket.
- **DLQ browser** in admin (inspect/retry/discard). Alerts on DLQ depth.

## 9.8 Usage 6 — Flight State (hot store)

- **Purpose:** the live representation used for diffing (takeoff/landing detection) and for the
  fast read path (map/flight page) without hitting Postgres.
- **Structures:**
  - `flight:state:<flightId>` — Hash: last position + phase + status + versions.
  - `flights:active` — Set of currently-active `flightId`s (mirrors partial index).
  - `geo:positions` — **Redis GEO** set (`GEOADD`) of live aircraft for radius/bbox queries
    (viewport), rebuilt continuously; complements PostGIS for the hot path.
  - `flight:track:<flightId>` — capped List of recent points for instant polyline on open.
- **Lifecycle:** created on `FlightDetected`, updated each position, expired on `FlightEnded`
  (+ TTL safety net). Rebuildable from DB if lost.

## 9.9 Usage 7 — Rate limiting, locks, misc

- **Rate limiting (API):** sliding-window / token-bucket per IP + per user + per route
  (`rl:<scope>:<id>`), atomic via Lua script; feeds 429 + `Retry-After` (see [15](./15-security.md)).
- **Rate limiting (providers/OpenSky):** shared token buckets so all replicas honor one budget
  (see [08](./08-providers.md)).
- **Distributed locks:** `lock:<name>` via `SET NX PX` (+ fencing token) for: tracker **leader
  election / poll shard ownership**, provider **single-flight** fetch coalescing, and any
  singleton scheduled job. Redlock considered only if multi-node Redis without a single primary.
- **Idempotency keys:** `idem:<key>` short-TTL to dedupe at-least-once deliveries at consumers.
- **Ephemeral counters:** realtime landing-page counters (`counter:flights_live`,
  `counter:events_today`) via `INCR`/`GETSET` with periodic reconciliation to DB.
- **Presence:** WS connection registry `ws:conn:<nodeId>` / `ws:subs:<flightId>` (Sets) to know
  which nodes have subscribers (optional optimization for fan-out).

## 9.10 Scaling & operations

- **Start:** one Redis instance, all uses. **Scale path:**
  1. Separate **BullMQ** onto its own instance (queues are the heaviest, most persistent load).
  2. Separate **pub/sub + streams** (realtime) from **cache/state**.
  3. Move to **Cluster** with hash-tags (`{flightId}`) for state/streams, or Sentinel for HA.
- **Persistence:** AOF (everysec) for queues/state that benefit from durability; cache-only
  instances can run RDB-light or no persistence.
- **Memory policy:** `maxmemory` + `allkeys-lru` on cache instance; **`noeviction` on
  queue/stream instance** (never evict jobs/events) — a hard reason to split instances.
- **Backpressure:** if `persist.positions` lag grows, tracker sheds to sampling (store every Nth
  position) while still emitting realtime — protects DB, keeps UX live.
- **Monitoring:** hit-rate, memory, evictions, connected clients, pub/sub channels, stream
  lengths, consumer-group lag, per-queue depth/failed — surfaced in admin cache/queue views
  ([03](./03-ux.md)) and Grafana ([14](./14-infrastructure.md)).

## 9.11 Failure behavior

| Failure | Effect | Mitigation |
|---------|--------|------------|
| Redis unavailable | no cache/realtime/queues | api serves from DB (degraded, slower); tracker buffers positions in memory bounded, resumes; UI shows "reconnecting"; alerts fire |
| Cache instance down | cache misses | read-through hits DB; providers protected by DB `provider_cache` |
| Queue instance down | jobs pause | producers persist to outbox/DB; drain on recovery (at-least-once) |
| Memory pressure (cache) | LRU evicts | acceptable; keys are rebuildable |
| Split-brain lock | double poll risk | fencing tokens + short lock TTL + idempotent ingestion |
