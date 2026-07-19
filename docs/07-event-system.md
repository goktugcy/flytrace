# 07 — Event System

Everything meaningful that happens is a **typed domain event**. Events are the contract
between modules and the substrate for realtime, notifications, analytics, and audit.

## 7.1 Principles

1. **Events are facts, past-tense, immutable.** `TakeoffDetected`, not `DetectTakeoff`.
2. **One event, many consumers.** Producers never know consumers.
3. **Idempotent & replayable.** Every event has a stable `dedupe_key`; consumers upsert.
4. **Reliable emission.** Emitted via **transactional outbox** when tied to a DB write, so a
   committed state change always produces its event exactly once.
5. **Typed & validated.** Every event has a Zod schema in `packages/shared/events`; producers
   and consumers `parse` the envelope.
6. **Two transports, chosen by need:** Redis **Pub/Sub** for fire-and-forget realtime fan-out
   (positions), Redis **Streams / BullMQ** for durable, retryable work (notifications, provider
   fetch, persistence). See [09](./09-redis.md).

## 7.2 Event envelope (common to all events)

```
EventEnvelope<T> = {
  id: string          // uuid v7 — unique event id
  type: string        // "TakeoffDetected"
  version: number     // schema version, for evolution
  occurredAt: string  // ISO — when the fact happened (event time)
  emittedAt: string   // ISO — when emitted (processing time)
  producer: string    // "tracker" | "worker:provider" | "notifier" | "api"
  correlationId: string   // trace id across the whole causal chain
  causationId?: string    // id of the event/command that caused this one
  dedupeKey: string   // idempotency key for consumers
  partitionKey: string// e.g. flightId — ordering/sharding hint
  payload: T          // event-specific, Zod-validated
}
```

## 7.3 Transport selection matrix

| Need | Transport | Delivery | Ordering | Example |
|------|-----------|----------|----------|---------|
| Realtime UI fan-out | Redis Pub/Sub | at-most-once | none (best-effort) | `PositionUpdated` → WS |
| Missed-message replay for reconnect | Redis Stream (per channel) | at-least-once w/ cursor | per-stream | WS resume backfill |
| Durable side effect w/ retry | BullMQ (Redis) | at-least-once | per-queue/job | provider fetch, notify |
| Cross-module domain fact | Outbox → bus (pub/sub + stream) | at-least-once | per partitionKey | `TakeoffDetected` |

Rule of thumb: **if losing it is fine (a superseded position), pub/sub. If losing it is a bug
(a missed notification), BullMQ/outbox.**

## 7.4 Event catalog

Each event: **payload · producer · consumers · transport · retry strategy · idempotency.**

### `FlightDetected`
- **Meaning:** a flight leg observed for the first time (new `flights` row created/linked).
- **Payload:** `{ flightId, callsign, icao24, firstPosition, source }`
- **Producer:** `tracker` (via outbox after upsert).
- **Consumers:** `worker` (enrichment: resolve airline/aircraft/airport, link watchlist
  matches), `api` (WS: add to viewport), analytics.
- **Transport:** outbox → stream + pub/sub. **Retry:** worker job 5×, exp backoff.
- **Idempotency:** `dedupeKey = flightId:detected`.

### `FlightUpdated`
- **Meaning:** flight metadata changed (aircraft linked, route resolved, status field).
- **Payload:** `{ flightId, changes: Partial<FlightSnapshot> }`
- **Producer:** `worker` (enrichment), `tracker`.
- **Consumers:** `api` (WS flight channel), dashboard projections.
- **Transport:** pub/sub (+ stream for reconnect). **Retry:** n/a (fire-and-forget UI).
- **Idempotency:** last-writer-wins on `flightId` via versioned snapshot.

### `PositionUpdated`
- **Meaning:** a new position sample for a flight.
- **Payload:** `{ flightId, icao24, lat, lon, altFt, headingDeg, gsKt, vrateFpm, onGround, ts, source?, sourceTimestamp?, receivedAt?, ageMs?, quality?, positionSource?, isMlat?, qualityState? }`
- **Producer:** `tracker`.
- **Consumers:** `api` (WS viewport + flight channels), `worker` (batched persistence).
- **Transport:** **pub/sub** (realtime) + enqueue `persistPosition` (durable). High volume →
  never blocks on DB. **Retry:** persistence job 3×; pub/sub not retried (next sample supersedes).
- **Idempotency:** `(flightId, ts)` unique on persistence.

### `FlightDelayed` / `FlightStale` / `FlightSignalLost` / `FlightRecovered`
- **Meaning:** realtime freshness lifecycle for a tracked aircraft, derived from the age of the
  last accepted position. Default thresholds: live ≤15s, delayed ≤30s, stale ≤60s,
  signal_lost ≤90s, then `FlightEnded`.
- **Payload:** `{ flightId, icao24, state, at, lastPositionAt, ageMs }`
- **Producer:** `tracker`.
- **Consumers:** `api` (WS viewport + flight channels), web map (opacity/freeze/prune).
- **Transport:** pub/sub + stream. **Retry:** n/a for UI; the next snapshot or position repairs
  state. **Idempotency:** `flightId:quality:<state>:<seq>`.

### `TakeoffDetected`
- **Meaning:** transition on-ground → airborne (sustained), confirmed over N samples.
- **Payload:** `{ flightId, at, position, confidence, source }`
- **Producer:** `tracker` (state-diff detector).
- **Consumers:** `notifier` (takeoff alerts), `api` (timeline), analytics.
- **Transport:** outbox → stream + pub/sub. **Retry:** notifier job 5× exp backoff → DLQ.
- **Idempotency:** `dedupeKey = flightId:takeoff` (once per leg).

### `LandingDetected`
- **Meaning:** transition airborne → on-ground (sustained) near destination.
- **Payload:** `{ flightId, at, airportId?, position, confidence, source }`
- **Producer:** `tracker`. **Consumers:** `notifier`, `api`, analytics.
- **Transport/Retry/Idempotency:** as takeoff; `dedupeKey = flightId:landing`.

### `ClimbDetected` / `DescentDetected` (incl. TOC/TOD)
- **Meaning:** sustained vertical-rate crossing thresholds (climb > +500fpm, descent < -500fpm),
  and top-of-climb/top-of-descent inflection.
- **Payload:** `{ flightId, phase, at, altFt, vrateFpm, confidence }`
- **Producer:** `tracker`. **Consumers:** `notifier` (descending alert), `api` (timeline).
- **Transport:** pub/sub + stream. **Retry:** notify job 3×. **Idempotency:**
  `flightId:descent:<phaseBucket>`.

### `EnteredAirspace`
- **Meaning:** aircraft crossed into a watched geofence (airport TMA, FIR, custom).
- **Payload:** `{ flightId, geofenceId, airspaceName?, airspaceType?, at, position }`
- **Producer:** `tracker` using the airspace service delta helper
  (`enteredAirspaceEventInputs`). **Consumers:** `notifier`, `api`.
- **Transport:** pub/sub + stream. **Retry:** 3×. **Idempotency:** `flightId:airspace:geofenceId`.

### `AircraftChanged`
- **Meaning:** the aircraft (icao24/registration) serving a flight number changed vs history.
- **Payload:** `{ flightId, flightNumber, previousIcao24, newIcao24 }`
- **Producer:** `worker` (enrichment). **Consumers:** `notifier` (enthusiast alert), analytics.
- **Transport:** stream. **Retry:** 3×. **Idempotency:** `flightNumber:date:aircraftChange`.

### `ProviderUpdated`
- **Meaning:** a provider returned new normalized status for a flight (may imply sub-events).
- **Payload:** `{ flightId, providerKey, before, after, diff }` (diff includes gate, terminal,
  status, sched/est/act times, baggage).
- **Producer:** `worker` (provider fetch job). **Consumers:** `notifier` (derives
  `GateChanged`/`Delay`/`Cancelled`/`Arrived`), `api` (WS), status projection.
- **Transport:** outbox → stream + pub/sub. **Retry:** fetch job 5× exp backoff + jitter; on
  repeated failure → provider circuit opens (see [08](./08-providers.md)).
- **Idempotency:** `flightId:provider:<fetchedAtBucket>`; downstream sub-events keyed by field.

### Derived notification sub-events (from `ProviderUpdated`)
`GateChanged` (`flightId:gate:<new>`), `DelayDetected` (`flightId:delay:<estBucket>`),
`FlightCancelled` (`flightId:cancelled`), `ArrivedAtGate` (`flightId:arrived`). Producer:
`notifier`/`worker` diff step. Consumers: `notifier` delivery, `api` timeline.

### `NotificationRequested`
- **Meaning:** a watch rule matched an event; a notification should be sent.
- **Payload:** `{ userId, watchlistItemId, flightEventId, channels[], renderContext }`
- **Producer:** `notifier` (rule matcher) or `worker`. **Consumers:** `notifier` delivery workers
  (one job per channel).
- **Transport:** **BullMQ** (durable). **Retry:** per-channel policy (see below) → DLQ.
- **Idempotency:** `dedupeKey = userId:flightEventId:channel`.

### `NotificationSent` / `NotificationFailed`
- **Meaning:** delivery outcome per channel.
- **Payload:** `{ notificationId, userId, channel, status, providerMessageId?, error? }`
- **Producer:** `notifier`. **Consumers:** `api` (WS dashboard feed), analytics, `notifications`
  table writer.
- **Transport:** pub/sub + persist. **Retry:** the *send* is retried upstream; this outcome event
  is not retried. **Idempotency:** `notificationId:status`.

### `FlightEnded`
- **Meaning:** leg complete — landed + on-block (or arrival timeout with no signal).
- **Payload:** `{ flightId, endedAt, reason: landed|arrived|timeout|diverted }`
- **Producer:** `tracker`/`worker`. **Consumers:** `worker` (finalize track, downsample, expire
  Redis state, expire watchlist items), `notifier` (arrived alert), `api`.
- **Transport:** outbox → stream. **Retry:** finalize job 5×. **Idempotency:** `flightId:ended`.

## 7.5 Retry strategy (standard policies)

| Class | Attempts | Backoff | On exhaustion |
|-------|----------|---------|---------------|
| Realtime (pub/sub) | 0 | — | dropped (next sample supersedes) |
| Persistence | 3 | exp 1s→8s | DLQ `persist.dlq`, alert if depth > N |
| Provider fetch | 5 | exp 2s→2m + jitter | DLQ + open provider circuit |
| Notification send | 5 | exp 5s→10m + jitter | DLQ `notify.dlq`, mark `failed`, surface in dashboard |
| Enrichment | 5 | exp 1s→1m | DLQ, flight remains position-only |

- **Jitter** on all exponential backoffs to avoid thundering herds.
- **DLQ** per pipeline; admin can inspect/retry/discard (see [03](./03-ux.md) admin, [09](./09-redis.md)).
- **Poison-message handling:** payloads failing schema validation go straight to a `malformed`
  DLQ (no retry) with the raw payload for debugging.

## 7.6 Ordering & partitioning

- Ordering matters **per flight**, not globally. `partitionKey = flightId` ensures a flight's
  events are processed in order within a consumer (single-consumer-per-partition for stream
  consumers; BullMQ per-flight lock where strict order is required, e.g. state transitions).
- Position stream is best-effort; UI tolerates out-of-order via `ts` compare (drop older).

## 7.7 Schema evolution & versioning

- Envelope carries `version`. Adding optional fields = non-breaking (bump minor, same major).
- Breaking change = new `type` version handled by consumers during a migration window
  (consume both). Never mutate a published event's meaning.
- All schemas centralized in `packages/shared/events/*` with a registry mapping `type →
  { version, schema }`; a **contract test** (see [16](./16-testing.md)) asserts every produced event
  validates and every consumer handles its declared versions.

## 7.8 Observability of events

- Every event logged with `correlationId`/`causationId` → full causal trace
  (position → takeoff → notificationRequested → notificationSent).
- Metrics: events/sec by type, consumer lag (stream), DLQ depth, retry counts, end-to-end
  latency histograms (event→WS, event→notification).
- Tracker hot state carries per-flight debug fields for production diagnosis: selected provider,
  candidate providers, provider candidate scores, source/receive timestamps, last accept/reject
  times, rejection reason, quality transition history, sequence, and the last WS publish marker.
- Standard tracker rejection reasons include `stale_observation`, `duplicate_timestamp`,
  `out_of_order`, `invalid_coordinates`, `impossible_jump`, `provider_timeout`,
  `missing_position`, `invalid_speed`, and `lower_quality_candidate`.
- Dashboards + alerts in [14](./14-infrastructure.md).

## 7.9 Local/testing affordances

- In-memory `EventBus` implementation (same interface) for unit tests.
- A **fixture OpenSky feed** replays recorded position sequences so takeoff/landing/descent
  detectors and the whole event chain can be tested deterministically (with injectable clock).
- Golden-file tests assert the exact event sequence produced for a known track.
