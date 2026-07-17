# 16 — Testing

Testing strategy spans the pyramid — fast unit tests at the base, targeted integration and
contract tests in the middle, and a thin layer of end-to-end and non-functional tests at the
top. The event-driven, provider-based architecture gets special attention (determinism,
contracts, idempotency).

## 16.1 Philosophy & pyramid

```
        ▲  e2e (Playwright) — few, critical journeys
        │  non-functional — load, soak, Lighthouse, a11y, security
        │  integration — DB+Redis+queues real, pipeline slices
        │  contract — Zod/OpenAPI/event registry, provider interface
        ▼  unit — pure services, detectors, reducers, utils (many, fast)
```

- Test **behavior at boundaries**, not implementation details.
- **Determinism first:** injectable `clock`, seeded ids, fixture feeds → no flaky time/network.
- **Fakes over mocks** for infra ports (in-memory bus, fake provider, fake OpenSky feed) so we
  test real logic against realistic doubles.

## 16.2 Tooling

| Layer | Tool |
|-------|------|
| Unit / integration (BE) | **`bun test`** (fast, native TS) + Testing Library for hooks |
| Component (FE) | Vitest + React Testing Library |
| Contract | Zod schema assertions, `zod-openapi` snapshot, event registry validator |
| Integration infra | Testcontainers (Postgres+PostGIS, Redis) or CI service containers |
| E2E | **Playwright** (chromium/webkit/firefox), against a Compose stack |
| Load | k6 (HTTP + WS) |
| Lighthouse/perf | Lighthouse CI |
| A11y | axe-core (jest-axe / Playwright-axe) |
| Visual regression | Playwright screenshots / Chromatic (optional) for `packages/ui` |
| Mutation (selective) | Stryker on critical logic (detectors, rule matcher) |

## 16.3 Unit tests (base)

Target the pure logic that carries the most risk:
- **Event detectors (`tracker`):** given a fixture position sequence + injected clock, assert the
  exact events (takeoff/landing/climb/descent/TOC/TOD/geofence) with correct `occurredAt`,
  `confidence`, and **idempotent `dedupeKey`**. Golden-file the full event sequence per track.
- **Provider `normalize()`:** raw fixture → `NormalizedFlightStatus` (all field mappings, status
  vocabulary, missing-field handling). One golden fixture set per provider.
- **Notification rule matcher:** watch rules + event + quiet hours → expected
  `NotificationRequested` set (per channel), including dedupe and critical-bypass logic.
- **Reducers/formatters (FE):** WS delta merge, interpolation math, unit/tz formatting.
- **Config loader, error mapper, cursor pagination codec, geo helpers.**

## 16.4 Contract tests (the architectural safety net)

Because modules communicate via contracts, contracts are tested explicitly:
- **API ↔ client:** every endpoint's response validated against its Zod schema; generated
  **OpenAPI** snapshot diffed in CI (breaking change → fail). The shared typed client is built
  from the same schemas, so drift is a compile error.
- **Event registry:** a test iterates the event registry ([07](./07-event-system.md) §7.7) — every event
  type has a schema + version; every producer's emitted sample validates; every consumer
  declares which versions it handles.
- **Provider interface conformance:** a shared test suite runs against **every** registered
  provider (real or fake) asserting it satisfies `FlightProvider` (methods, capabilities,
  normalized output schema, timeout/error behavior via the base).
- **WS protocol:** client/server message schemas validated both directions; snapshot of the
  protocol version.
- **DB schema ↔ Drizzle:** migration applied to a fresh DB in CI; drift check (schema vs
  migrations) fails if they diverge.

## 16.5 Integration tests (mid)

Run against **real Postgres+PostGIS + Redis** (ephemeral):
- **Ingestion pipeline slice:** feed a fixture OpenSky batch → assert positions persisted,
  `flight:state` updated, `flights.active` set correct, `PositionUpdated` on the bus, and
  takeoff derived + written to `flight_events` (idempotent on replay).
- **Outbox → bus:** write in a transaction, assert the relay publishes exactly once to
  stream+pubsub, and a consumer group processes at-least-once with acks (and dedupes replays).
- **Provider fetch job:** with a fake provider, assert cache read-through (Redis→DB→fetch),
  rate-limit/coalescing, circuit-breaker open/half-open transitions, `ProviderUpdated` + derived
  gate/delay events.
- **Notification pipeline:** event → matcher → BullMQ → fake channel adapter → `notifications`
  row + `NotificationSent`; assert **exactly-once** per (user,event,channel) under retry/replay.
- **Repositories:** module-scoped queries incl. PostGIS (bbox/nearest), cursor pagination,
  partial indexes hit (EXPLAIN assertion on hot queries).
- **Auth/authz:** ownership enforcement (IDOR attempts return 403/404), role guards, rate-limit
  behavior.

## 16.6 End-to-end tests (top, thin)

Playwright against a full Compose stack seeded with fixtures + a **replayable fixture feed**
driving the tracker (deterministic live data):
- **Guest journey:** search `TK1980` → flight page renders live values → timeline shows takeoff.
- **Conversion:** flight page "notify me" → sign-up → create watch → confirmation.
- **Telegram link flow:** generate deep link → simulate `/start <token>` webhook → channel shows
  connected.
- **Realtime:** open flight page, feed positions → assert map marker moves + telemetry updates
  over WS; kill WS → "reconnecting" chip → resume → no duplicate toasts (reconnect replay).
- **Dashboard:** watch fires → notification appears in the live feed.
- **Admin:** provider health board reflects a forced provider failure; DLQ retry works.
- Cross-browser (chromium + webkit) for critical paths; mobile viewport for responsive flows.

## 16.7 Non-functional tests

- **Load (k6):**
  - HTTP: search, flight detail, airport board at target RPS; assert p95 latency + error budget.
  - WS: ramp to N concurrent connections, M subscriptions each; measure fan-out lag, memory,
    dropped messages; validate horizontal scaling with multiple api nodes + Redis.
  - Ingestion: high position throughput → assert backpressure/sampling kicks in, DB not saturated.
- **Soak:** 12–24h at moderate load → watch for leaks (connections, memory, stream growth, queue
  creep).
- **Lighthouse CI:** landing + flight + dashboard pages assert **Perf ≥ 95, A11y ≥ 95**,
  LCP/INP/CLS budgets; fails PR on regression.
- **A11y:** axe on every key page (0 serious/critical violations); keyboard-nav + reduced-motion
  smoke; screen-reader label checks on live regions/maps.
- **Bundle budgets:** size-limit per route/chunk (map, 3D, charts split); PR fails on budget
  breach.
- **Security tests:** see [15](./15-security.md) — SAST (CodeQL), dep audit, secret scan (gitleaks),
  image scan (Trivy), plus targeted tests (CSRF token required, IDOR blocked, rate-limit 429,
  CSP present, no PII in logs). Periodic DAST (ZAP) against staging.
- **Chaos (staged):** kill Redis/DB/provider in staging → assert graceful degradation
  (cache-serve, position-only status, queue drain on recovery) matches [09](./09-redis.md)/[08](./08-providers.md).

## 16.8 Test data & fixtures

- **Fixture library** in `packages/shared/testing`: recorded OpenSky tracks (incl. a full
  IST→LHR with takeoff/cruise/descent/landing), raw provider responses per airline, seeded
  users/watches, airports/aircraft catalog subset.
- **Factories** for DB rows (typed builders) + a `resetDb()` between integration tests.
- **Injectable clock + seeded UUID v7** for deterministic timestamps/ids.
- No real external calls in CI (network egress disabled for unit/integration).

## 16.9 Coverage & quality gates

- Coverage targets: **core logic (detectors, matcher, providers, services) ≥ 90%**; overall
  ≥ 80%. Coverage is a signal, not a goal — critical paths must be meaningfully asserted.
- CI gates to merge `main` ([14](./14-infrastructure.md) §14.5): typecheck, lint/format, unit,
  contract, integration, e2e smoke, a11y, Lighthouse, bundle budgets, security scans — all green.
- Mutation testing (Stryker) run nightly on detectors + rule matcher to catch weak assertions.

## 16.10 Developer workflow

- `bun test --watch` locally; `turbo test --filter=[changed]` for affected-only.
- Pre-commit (lefthook/husky): format + lint + typecheck on staged; fast unit on affected.
- PR template requires: tests added/updated, contracts updated, a11y considered, perf impact
  noted. Flaky tests quarantined + tracked, not ignored.
- Every bug fix ships with a regression test reproducing it.
