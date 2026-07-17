# 05 — Database

PostgreSQL 16 + **PostGIS** + **TimescaleDB** (optional, for position/time-series hypertables).
Access exclusively through **Drizzle ORM** in `packages/db`. This is the single durable
source of truth; Redis holds only ephemeral/derived state.

## 5.1 Design rules

- **UUID v7** primary keys (`uuid` column, generated app-side) — time-ordered, index-friendly,
  no cross-service collisions when modules are extracted. Natural keys (IATA, ICAO, icao24)
  are unique columns, not PKs.
- **`created_at` / `updated_at`** (`timestamptz`, UTC) on every mutable table; `updated_at`
  maintained by trigger.
- **Soft delete** (`deleted_at`) only where user-recoverable (watchlist, favorites); hard
  delete elsewhere.
- **No cross-module FK where a module could be extracted** as a service; instead, "reference
  by id + eventual consistency" for those seams. Within a module, FKs with explicit
  `ON DELETE` behavior.
- **Enums** as Postgres `enum` types for closed sets (flight_status, event_type, channel).
- **Time-series** (positions) partitioned by time (native partitioning or Timescale hypertable);
  aggressive retention + downsampling.
- **PostGIS `geography(Point,4326)`** for positions/airports; `geometry` for runways/airspace.
- Every table below lists **why it exists** and **key indexes**.

## 5.2 Entity-relationship overview

```
users ──1:n── sessions
users ──1:n── accounts            (Better Auth: OAuth/credential links)
users ──1:n── watchlist_items ──n:1── flights
users ──1:n── favorites            (polymorphic: route|aircraft|airport)
users ──1:n── notification_channels (telegram|webpush|email)
users ──1:n── notifications ──n:1── flight_events
users ──1:1── user_settings

airlines ──1:n── flights
airports ──1:n── flights (origin/destination)
aircraft ──1:n── flights
flights ──1:n── flight_positions   (time-series)
flights ──1:n── flight_events
flights ──1:1── flight_status      (latest normalized provider status)

providers ──1:n── provider_logs
providers ──1:n── provider_cache
(system) ──── audit_logs, settings, outbox
```

## 5.3 Reference / catalog tables

### `airlines` — *why:* stable identity + branding for display, provider mapping.
| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| iata | char(2) unique | e.g. `TK` |
| icao | char(3) unique | e.g. `THY` |
| name | text | Turkish Airlines |
| callsign | text | "TURKISH" |
| country | text | |
| logo_url | text | CDN asset |
| provider_key | text null | maps to a registered provider (`thy`), nullable |
| active | boolean | |
Indexes: `unique(iata)`, `unique(icao)`, `idx(provider_key)`.

### `airports` — *why:* origin/destination, airport pages, geofencing.
| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| iata | char(3) unique null | `IST` |
| icao | char(4) unique | `LTFM` |
| name | text | |
| city / country | text | |
| location | geography(Point,4326) | PostGIS |
| elevation_ft | int | |
| timezone | text | IANA tz (`Europe/Istanbul`) |
| runways | jsonb | array {designator,length_ft,surface,heading} |
Indexes: `unique(icao)`, `unique(iata)`, **GIST(location)** (nearest-airport, geofence).

### `aircraft` — *why:* aircraft pages, enrichment, type/registration display.
| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| icao24 | char(6) unique | hex transponder id (join key with OpenSky) |
| registration | text unique null | `TC-JJE` |
| type_icao | text null | `B77W` |
| type_name | text null | Boeing 777-300ER |
| airline_id | uuid FK→airlines null | operator |
| manufacturer | text null | |
| built_year | int null | |
| seats | int null | |
Indexes: `unique(icao24)`, `unique(registration)`, `idx(airline_id)`, `idx(type_icao)`.

## 5.4 Flight domain tables

### `flights` — *why:* a flight leg is the core aggregate; everything hangs off it.
| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| callsign | text | `THY1980` (as transmitted) |
| flight_number | text null | `TK1980` (marketed) |
| airline_id | uuid FK→airlines null | |
| aircraft_id | uuid FK→aircraft null | |
| origin_airport_id | uuid FK→airports null | |
| destination_airport_id | uuid FK→airports null | |
| scheduled_departure | timestamptz null | |
| scheduled_arrival | timestamptz null | |
| estimated_departure | timestamptz null | |
| estimated_arrival | timestamptz null | |
| actual_departure | timestamptz null | off-block/takeoff derived |
| actual_arrival | timestamptz null | on-block/landing derived |
| status | flight_status enum | scheduled/active/landed/delayed/cancelled/diverted/unknown |
| flight_date | date | service date, for uniqueness |
| last_seen_at | timestamptz | last position/status touch |
| source | text | `opensky`, `provider:thy` |
Constraints: `unique(callsign, flight_date)` (one leg per callsign per day).
Indexes: `idx(flight_number)`, `idx(status)`, `idx(last_seen_at)`, `idx(origin, sched_dep)`,
`idx(destination, sched_arr)`, partial `idx(status) WHERE status='active'` (hot live set).
*Extraction note:* airline/aircraft/airport ids are within the same "catalog" seam, FKs OK.

### `flight_positions` — *why:* the track; time-series, high volume.
| column | type | notes |
|--------|------|-------|
| id | uuid | (or bigserial within partition) |
| flight_id | uuid FK→flights | |
| icao24 | char(6) | denormalized for raw-ingest joins |
| ts | timestamptz | position time (PK component) |
| location | geography(Point,4326) | |
| altitude_ft | int null | barometric |
| geo_altitude_ft | int null | |
| heading_deg | real null | |
| ground_speed_kt | real null | |
| vertical_rate_fpm | int null | |
| on_ground | boolean | |
| squawk | text null | |
| source | text | opensky |
Partitioning: **by `ts`** (daily/weekly) or Timescale hypertable on `ts`.
PK: `(flight_id, ts)`. Indexes: **GIST(location)** (bbox/viewport queries), `idx(icao24, ts)`,
BRIN on `ts` for scan efficiency.
Retention: raw positions kept e.g. 7–30 days; **continuous aggregate / rollup** to
`flight_tracks_downsampled` (1 point / 15–30s) for long-term history.

### `flight_tracks_downsampled` — *why:* cheap historical track render without raw volume.
`(flight_id, ts, location, altitude_ft, heading_deg, ground_speed_kt)`; produced by rollup job
or Timescale continuous aggregate. Retention months–years.

### `flight_events` — *why:* derived domain facts; drives timeline, notifications, analytics.
| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| flight_id | uuid FK→flights | |
| type | event_type enum | takeoff/landing/descent/climb/gate_change/delay/cancelled/... |
| occurred_at | timestamptz | when it happened (event time) |
| detected_at | timestamptz | when we derived it (processing time) |
| confidence | real | 0..1 |
| source | text | `derived:position` / `provider:thy` |
| payload | jsonb | typed per event (old/new gate, delay minutes, position) |
| dedupe_key | text | idempotency (e.g. `flight_id:type:bucket`) |
Constraints: `unique(dedupe_key)` (idempotent event derivation).
Indexes: `idx(flight_id, occurred_at)`, `idx(type, occurred_at)`.

### `flight_status` — *why:* latest normalized provider status snapshot (1 row per flight).
| column | type | notes |
|--------|------|-------|
| flight_id | uuid PK FK→flights | 1:1 |
| provider_key | text | which provider produced it |
| status | flight_status enum | |
| gate / terminal | text null | |
| baggage_belt | text null | |
| scheduled_* / estimated_* / actual_* | timestamptz | mirror of provider fields |
| raw | jsonb | normalized provider response (audit/debug) |
| fetched_at | timestamptz | |
Index: `idx(provider_key, fetched_at)`.

## 5.5 User & auth tables (Better Auth compatible)

### `users` — *why:* identity, ownership of personalization.
`id uuid PK, email citext unique, email_verified bool, name text, image text null,
role user_role enum(user|admin), created_at, updated_at`. Index `unique(email)`.

### `accounts` — *why:* Better Auth provider links (OAuth/credentials).
`id uuid PK, user_id FK→users, provider text, provider_account_id text, access_token text null,
refresh_token text null, expires_at timestamptz null, password_hash text null`.
`unique(provider, provider_account_id)`, `idx(user_id)`.

### `sessions` — *why:* server-managed sessions for Better Auth.
`id uuid PK, user_id FK→users, token text unique, ip inet null, user_agent text null,
expires_at timestamptz, created_at`. `idx(user_id)`, `unique(token)`, `idx(expires_at)`.

### `user_settings` — *why:* preferences (theme, locale, units, quiet hours).
`user_id uuid PK FK→users, theme text, locale text, distance_unit text(km|mi|nm),
time_format text, quiet_hours jsonb {tz,start,end}, default_channels jsonb`.

## 5.6 Personalization tables

### `watchlist_items` — *why:* the core "track this flight and notify me" object.
| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| user_id | uuid FK→users | |
| flight_id | uuid FK→flights null | resolved leg |
| match | jsonb | matcher when leg not yet known: {flight_number, date} / {route} / {icao24} |
| event_types | event_type[] | which triggers to notify on |
| channels | channel[] | telegram/webpush/email (subset of user's connected) |
| active | boolean | |
| expires_at | timestamptz null | auto-expire after arrival + grace |
| deleted_at | timestamptz null | soft delete |
Indexes: `idx(user_id, active)`, `idx(flight_id) WHERE active`, GIN on `match`.
*Why match jsonb:* users watch flights before a `flights` row exists; resolver links later.

### `favorites` — *why:* quick access to routes/aircraft/airports (no notifications).
`id uuid PK, user_id FK, kind favorite_kind enum(route|aircraft|airport), ref jsonb
({iata_from,iata_to} | {icao24} | {iata}), created_at`. `unique(user_id, kind, ref)`.

### `notification_channels` — *why:* per-user delivery endpoints, verification state.
| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| user_id | uuid FK→users | |
| channel | channel enum(telegram|webpush|email) | |
| address | jsonb | telegram:{chat_id}, webpush:{endpoint,keys}, email:{addr} |
| verified | boolean | |
| link_token | text null | one-time token for telegram linking |
| enabled | boolean | |
Indexes: `idx(user_id, channel)`, `unique(channel, address)` (functional/expression index),
`idx(link_token) WHERE link_token IS NOT NULL`.

## 5.7 Notification tables

### `notifications` — *why:* the record of every alert (history, dedupe, audit, dashboard feed).
| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| user_id | uuid FK→users | |
| watchlist_item_id | uuid FK null | source subscription |
| flight_event_id | uuid FK→flight_events null | triggering event |
| channel | channel enum | |
| status | notif_status enum(queued|sent|delivered|failed|suppressed) | |
| title / body | text | rendered content |
| payload | jsonb | channel-specific render + deep link |
| dedupe_key | text | `user:event:channel` idempotency |
| error | text null | last failure reason |
| sent_at / delivered_at | timestamptz null | |
| created_at | timestamptz | |
Constraints: `unique(dedupe_key)` (exactly-once per user/event/channel).
Indexes: `idx(user_id, created_at desc)` (history feed), `idx(status)`, `idx(flight_event_id)`.

## 5.8 Provider & system tables

### `providers` — *why:* registry + health/config for each airline provider (admin board).
`id uuid PK, key text unique (thy|pegasus|ajet|lufthansa|ba), name text, enabled bool,
config jsonb, health provider_health enum(up|degraded|down), circuit_state text,
last_success_at timestamptz null, last_error text null, p50_ms int, p95_ms int, updated_at`.
Index `unique(key)`.

### `provider_cache` — *why:* durable cache of normalized provider responses (survives Redis),
polite to sources, dedupes fetches. (Hot layer is Redis; this is the cold/backing layer.)
`id uuid PK, provider_key text, cache_key text, payload jsonb, fetched_at timestamptz,
expires_at timestamptz`. `unique(provider_key, cache_key)`, `idx(expires_at)`.

### `provider_logs` — *why:* every provider fetch (request meta, latency, status) for
debugging, health scoring, ToS/rate audit.
`id uuid PK, provider_key text, operation text, request jsonb, status_code int null,
latency_ms int, success bool, error text null, correlation_id text, created_at`.
Indexes: `idx(provider_key, created_at)`, `idx(success, created_at)`, `idx(correlation_id)`.
Partitioned by `created_at` (weekly), retention ~30–90 days.

### `audit_logs` — *why:* who did what (admin actions, auth events, sensitive changes).
`id uuid PK, actor_user_id uuid null, actor_type text(user|system|admin), action text,
entity text, entity_id text, before jsonb null, after jsonb null, ip inet null,
correlation_id text, created_at`. Indexes: `idx(actor_user_id, created_at)`, `idx(entity, entity_id)`.
Append-only (no updates/deletes); partitioned by `created_at`.

### `settings` — *why:* runtime feature flags / operational config editable by admins.
`key text PK, value jsonb, description text, updated_by uuid null, updated_at`.
Examples: `opensky.poll_interval_ms`, `map.max_markers`, `providers.thy.enabled`,
`notifications.email.enabled`.

### `outbox` — *why:* transactional outbox for reliable event publishing (see [07](./07-event-system.md)).
`id uuid PK, aggregate text, aggregate_id uuid, event_type text, payload jsonb,
published boolean default false, created_at, published_at timestamptz null`.
Index: `idx(published, created_at) WHERE published = false`. Relay polls + publishes to Redis
bus, guaranteeing "DB write and event emit" cannot diverge.

## 5.9 Enums

```
flight_status  = scheduled | active | landed | delayed | cancelled | diverted | unknown
event_type     = flight_detected | flight_updated | takeoff | landing | climb | descent
               | top_of_climb | top_of_descent | gate_change | delay | cancelled
               | entered_airspace | arrived | flight_ended | aircraft_changed
channel        = telegram | webpush | email
notif_status   = queued | sent | delivered | failed | suppressed
user_role      = user | admin
favorite_kind  = route | aircraft | airport
provider_health= up | degraded | down
```

## 5.10 Indexing & performance strategy (summary)

- **Live map viewport:** `flight_positions` GIST(location) + latest-position materialized in
  Redis (`flight:state`); DB used for backfill/history, Redis for the hot read path.
- **Active flights set:** partial index `WHERE status='active'`; also mirrored in Redis set.
- **History feeds:** covering indexes ordered by `created_at desc`.
- **Time-series volume:** partition + BRIN + downsampling + retention jobs (worker).
- **Text search:** flights/airports search backed by a Redis/Postgres GIN trigram index or a
  denormalized search index refreshed on catalog updates.

## 5.11 Migrations & seeding

- **Drizzle Kit** migrations, versioned in `packages/db/migrations`, applied in CI/CD before
  deploy (see [14](./14-infrastructure.md)); never auto-migrate in app boot in prod.
- **Extensions bootstrapped** in first migration: `postgis`, `pg_trgm`, `citext`,
  (`timescaledb` if used).
- **Seed data:** airlines (TK/PC/AJ/LH/BA…), major airports (IATA/ICAO/geo/tz), aircraft type
  lookup — from static reference datasets, idempotent seed script.

## 5.12 Data lifecycle & retention

| Data | Hot | Retention | Mechanism |
|------|-----|-----------|-----------|
| Raw positions | Redis + DB | 7–30d | partition drop |
| Downsampled tracks | DB | months–years | continuous aggregate |
| Flight events | DB | indefinite (or years) | — |
| Provider logs | DB | 30–90d | partition drop |
| Audit logs | DB | 1–7y (compliance) | partition, cold storage |
| Notifications | DB | 1y | archive job |
| Sessions | DB | until expiry + sweep | expiry sweep job |
