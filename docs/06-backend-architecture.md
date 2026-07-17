# 06 — Backend Architecture

## 6.1 Architectural style: Modular Monolith (service-ready)

A **single deployable codebase** (one Turborepo) organized into independent **apps**
(processes) and shared **packages**. It is a monolith operationally (few processes, one DB,
one Redis) but **modular** in code: modules communicate through **contracts, events, and
queues**, never through shared mutable memory or cross-module DB reads.

**Why monolith now:** one team, one data model, lowest operational overhead, easiest local
DX, transactional consistency where it matters.

**Why service-ready:** each `apps/*` is already a separate process with its own entrypoint,
config, and health check. Extraction to a service = point it at the same Redis/DB over the
network and give it its own deploy unit. The seams below make that mechanical, not a rewrite.

### The five extraction rules (enforced in review)
1. **No cross-module DB access.** A module reads/writes only its own tables via `packages/db`
   repositories scoped to that module. Cross-module data comes via events or a queried API.
2. **Communicate via events/queues.** Side effects between modules go through the Redis event
   bus or BullMQ, never direct function calls into another module's internals.
3. **Contracts are packages.** Shared request/response/event shapes live in `packages/shared`
   as Zod schemas + inferred types. Modules depend on contracts, not each other.
4. **No shared in-process state.** No module relies on another running in the same process.
5. **Config & health per app.** Each app boots standalone with its own env + `/health`.

## 6.2 Repository layout (Turborepo)

```
flytrace/
├─ apps/
│  ├─ web/         Next.js App Router (public site + user app) — see 13
│  ├─ admin/       Next.js (admin console) — reuses packages/ui
│  ├─ api/         Hono HTTP + WebSocket gateway (edge of the system)
│  ├─ tracker/     OpenSky ingestion + state diff + event derivation
│  ├─ worker/      BullMQ consumers: enrichment, provider fetch, persistence, rollups
│  └─ notifier/    Consumes Notification* events → Telegram/Push/Email
├─ packages/
│  ├─ db/          Drizzle schema, migrations, repositories (per-module scoped)
│  ├─ providers/   FlightProvider interface, registry, concrete providers
│  ├─ notifications/ channel adapters + templating engine
│  ├─ maps/        MapLibre styles, tile config, geo helpers (shared FE/BE geo utils)
│  ├─ ui/          Design system (shadcn/ui + tokens) — see 04
│  └─ shared/      Zod contracts, event schemas, domain types, config, logger, errors
├─ infra/          docker-compose, Dockerfiles, k8s (later), grafana dashboards
├─ .github/workflows/  CI/CD — see 14
├─ turbo.json      pipeline (build/lint/test/typecheck caching)
├─ package.json    workspaces
└─ tsconfig.base.json
```

## 6.3 The apps (processes) and their responsibilities

### `apps/api` — the edge
- **Stack:** Bun + Hono + Zod. Terminates HTTP (REST, see [11](./11-api.md)) and WebSocket
  (gateway, see [12](./12-websocket.md)).
- **Responsibilities:** auth (Better Auth), request validation, authorization, read-path
  queries (mostly from Redis hot state + DB), enqueue commands, WebSocket fan-out from Redis
  pub/sub, admin API, rate limiting.
- **Does NOT:** poll OpenSky, run heavy jobs, call providers directly, or derive events.
- **Scaling:** stateless; scale horizontally behind LB; WS scaled via Redis pub/sub adapter.

### `apps/tracker` — ingestion & derivation
- **Responsibilities:** poll OpenSky on a schedule (respecting rate limits, [08](./08-providers.md)),
  normalize positions, diff against previous **flight state** in Redis, detect transitions
  (on-ground→air = takeoff, vertical-rate thresholds = climb/descent, geofence = airspace),
  emit domain events to the bus, and write positions via the worker/outbox.
- **Singleton concern:** polling must not double-run → guarded by a **Redis distributed lock**
  (leader election); other tracker replicas stand by / handle sharded bounding boxes.
- **Scaling:** shard by geographic bounding box or airline; each shard owns a lock.

### `apps/worker` — asynchronous work
- **Responsibilities:** BullMQ consumers for: position persistence (batched), flight
  enrichment (resolve airline/aircraft/airport, link watchlist matches), **provider fetch**
  jobs, event persistence, downsampling/rollup, retention/cleanup, search-index refresh.
- **Scaling:** scale by queue; concurrency per queue tuned to DB/provider limits.

### `apps/notifier` — delivery
- **Responsibilities:** consume `NotificationRequested` (and directly derivable events),
  evaluate watch rules + quiet hours + dedupe, render templates, deliver via channel adapters
  (`packages/notifications`), emit `NotificationSent`/failure, persist to `notifications`.
- **Scaling:** scale by channel; per-channel rate limiting + retry/backoff.

### `apps/web` / `apps/admin` — see [13](./13-frontend.md)
- Next.js frontends; talk only to `apps/api` (REST + WS). No direct DB/Redis access.

## 6.4 Layered module structure (inside a backend app)

Each backend module follows a consistent internal layering:

```
module/
├─ routes/         Hono handlers (thin): validate (Zod) → call service → serialize
├─ service/        use-cases / business logic (pure-ish, testable, no framework)
├─ repo/           Drizzle queries scoped to this module's tables
├─ events/         event producers/consumers for this module
├─ schema/         Zod contracts (re-exported from packages/shared where cross-module)
└─ index.ts        module composition (wire deps)
```

Rule: **routes never touch repo directly; services never touch `req/res`.** This keeps
services portable when a module is extracted.

## 6.5 Dependency injection strategy

- **Lightweight, explicit DI via composition roots** — no heavy framework/decorators. Each
  app has a `bootstrap()` that constructs dependencies and injects them.
- **Ports & adapters (hexagonal):** services depend on **interfaces** (ports) defined in
  `packages/shared`; concrete implementations (Drizzle repo, Redis client, provider registry,
  channel adapters) are injected at bootstrap.
- **A typed container object** (`AppContext`) carries `{ db, redis, bus, queues, providers,
  logger, config, clock }`. Passed into service factories: `makeFlightService(ctx)`.
- **Benefits:** trivial to swap real Redis for an in-memory fake in tests; no import-time side
  effects; extraction just changes which adapters are wired.

```
// conceptual (design-only)
type AppContext = {
  db: Database; redis: Redis; bus: EventBus; queues: Queues;
  providers: ProviderRegistry; notifications: ChannelRegistry;
  logger: Logger; config: Config; clock: Clock;
}
```

## 6.6 Cross-cutting concerns (in `packages/shared`)

- **Config:** Zod-validated env loader; fail-fast at boot; typed `config` object; per-app
  required-var sets. Never read `process.env` outside the loader.
- **Logger:** structured JSON (pino-style), correlation-id propagation, redaction of secrets/PII.
- **Errors:** typed error hierarchy (`AppError` with `code`, `httpStatus`, `retryable`);
  consistent API error envelope (see [11](./11-api.md)).
- **Clock:** injectable time source (deterministic tests; avoids `Date.now()` in logic).
- **IDs:** UUID v7 generator.
- **Result/validation:** Zod schemas shared; `parse` at every boundary (HTTP, queue payloads,
  provider responses, WS messages).
- **Telemetry:** OpenTelemetry tracing hooks; metrics registry.

## 6.7 Data flow (end-to-end, the golden path)

```
OpenSky ──poll──▶ tracker
   tracker: normalize → load flight:state (Redis) → diff
     ├─ position changed → publish PositionUpdated (bus) + enqueue persistPosition (BullMQ)
     ├─ on-ground→air     → publish TakeoffDetected (+ write outbox)
     └─ vrate < -X        → publish DescentDetected
   api (WS gateway) subscribes bus → fans out to viewport/flight channels → clients
   worker persistPosition → DB (batched); enrichment resolves fk + links watchlist
   worker (schedule) → provider fetch job → providers.get(flight) → normalize
     → upsert flight_status → publish ProviderUpdated (diff → GateChanged/Delay/Cancelled)
   notifier subscribes *Detected/ProviderUpdated → match watch rules → NotificationRequested
     → render + deliver (telegram/push/email) → NotificationSent → persist + WS to dashboard
```

## 6.8 Consistency model

- **Command → event → projection.** Writes go through services; durable state in Postgres;
  the **transactional outbox** guarantees events are emitted iff the DB write commits.
- **Redis is a derived cache/broker**, never the source of truth. On Redis loss, state is
  rebuilt from DB + next OpenSky poll.
- **Idempotency everywhere:** events carry `dedupe_key`; consumers upsert; notifications are
  exactly-once per (user,event,channel) via unique constraint.
- **Eventual consistency** across module seams is expected and acceptable (dashboard may lag
  a WS tick behind the map); UI reconciles.

## 6.9 Runtime & framework choices (rationale)

- **Bun:** fast startup, native TS, built-in test runner + bundler, great DX; consistent
  runtime across all backend apps.
- **Hono:** tiny, fast, edge-portable, first-class middleware, works on Bun; clean Zod
  integration; supports WebSocket.
- **Drizzle:** SQL-first, fully typed, migration tooling, no heavy runtime; readable queries;
  PostGIS via custom types/`sql` fragments.
- **BullMQ:** mature Redis-backed queues with retries, backoff, delayed jobs, repeatable jobs,
  DLQ, flow/parent-child — ideal for enrichment/provider/notification pipelines.
- **Zod:** single source of truth for validation + inferred types across boundaries.

## 6.10 Coding standards & conventions (backend)

- **TypeScript strict** everywhere; `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- **Naming:** files `kebab-case.ts`; types/classes `PascalCase`; funcs/vars `camelCase`;
  events `PascalCase` past-tense (`TakeoffDetected`); DB tables/columns `snake_case`.
- **No default exports** (predictable refactors); barrel `index.ts` per module.
- **Pure services:** business logic free of I/O framework; I/O behind ports.
- **Error handling:** never throw raw strings; wrap external failures in typed `AppError`.
- **Async:** no floating promises (lint-enforced); explicit timeouts on all network calls.
- **Boundaries validated:** every inbound payload `zod.parse`d; never trust upstream shape.
- **Lint/format:** Biome (or ESLint+Prettier) shared config in root; enforced in CI.

## 6.11 Local developer experience

- `bun install` at root; `turbo dev` starts all apps with hot reload.
- `docker compose up` for Postgres + Redis (+ optional tiles) — see [14](./14-infrastructure.md).
- `.env.example` per app; single `bun run db:migrate` / `db:seed`.
- Task graph cached by Turborepo (typecheck/lint/test/build) for fast CI and local runs.
- Fake adapters (in-memory bus, fake OpenSky fixture feed) let the whole pipeline run without
  external network — critical for tests and offline dev.
