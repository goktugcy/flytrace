# 08 — Providers

The provider system supplies **flight status** (the airline's operational view: gate, terminal,
scheduled/estimated/actual times, cancellation) to complement OpenSky **positions**. It lives
in `packages/providers` and is **never imported by the core** — only by `apps/worker` through a
registry. The platform is fully functional with zero providers (positions only); providers
enrich.

## 8.1 Design goals

1. **Uniform interface.** Every airline implements the same `FlightProvider` contract.
2. **Normalization.** Provider-specific responses are mapped into one canonical
   `NormalizedFlightStatus`; the rest of the system never sees provider-specific shapes.
3. **Loose coupling.** Core depends on the *interface* and a *registry*, not on any concrete
   provider. Providers can be added/removed without touching core.
4. **Politeness & compliance.** Rate limiting, caching, backoff, and **ToS-respecting use of
   only publicly available status** are built into the base, not each provider.
5. **Resilience.** Per-provider circuit breaker, timeouts, health scoring, graceful fallback.

## 8.2 Data-source split

| Concern | Source | Module |
|---------|--------|--------|
| Position (lat/lon/alt/heading/speed/vrate/on-ground) | **ADS-B feed** (default) or **OpenSky Network** | `apps/tracker` |
| Status (gate, terminal, sched/est/act, cancelled, baggage) | **Providers** (per airline) | `apps/worker` + `packages/providers` |

## 8.3 Position ingestion (ADS-B / OpenSky)

- **Endpoints:** ADS-B point/radius JSON (`ADSB_API_URL`, default `adsb.lol`) or OpenSky
  `/states/all` bounded by bbox. Consumed by `apps/tracker`.
- **Rate limits:** poll cadence is config-driven (`ADSB_POLL_INTERVAL_MS` or
  `OPENSKY_POLL_INTERVAL_MS`) and adapts to the selected source and account tier.
- **Politeness:** ETag/`If-Modified-Since` where supported; bbox scoping to avoid full-world
  polls; exponential backoff on 429/5xx; jitter; a single **leader** polls per shard
  (Redis lock) to avoid duplicate quota burn across replicas.
- **Attribution:** selected source credited in UI/footer/docs according to its terms.
- **Normalization:** source record → `PositionSample` (ft/kt/fpm, UTC ISO). Unknown/null fields
  are preserved as `null`, never fabricated.
- **Composite mode:** `TRACKER_SOURCE=composite` polls `TRACKER_PROVIDERS` (for example
  `opensky,adsb`) in parallel. Failures are isolated per provider; one timeout/rate-limit does
  not fail the whole tracker tick. Observations are deduped by ICAO24, scored by freshness,
  completeness, plausibility, provider priority, and source type, then a hysteresis margin keeps
  small score differences from flipping the selected provider every poll.
- **Composite debug metadata:** selected observations include `candidateProviders` and
  `providerCandidates` so an admin can see which provider won, which candidates were lower
  quality, and which were rejected as stale, invalid, or physically implausible.
- **Jump guard:** when switching providers, the selected position must remain physically
  plausible versus the previously accepted provider position. The default
  `TRACKER_PROVIDER_MAX_JUMP_SPEED_KT=1200` is intentionally high enough for aircraft but still
  rejects obvious cross-region teleports.
- **Freshness lifecycle:** live sources are aged against tracker wall time. Observations older
  than `TRACKER_MAX_POSITION_AGE_MS` are rejected; active hot states move through
  live/delayed/stale/signal_lost and are removed after `TRACKER_REMOVE_AFTER_MS`.

## 8.4 The `FlightProvider` interface (contract)

```
interface FlightProvider {
  readonly key: string;            // "aerodatabox", "thy", "pegasus", "ajet", "lufthansa", "ba"
  readonly airlineIata: string[];  // which airlines this provider covers, e.g. ["TK"]
  readonly capabilities: ProviderCapabilities; // { status, gate, baggage, schedule }

  // lifecycle
  init(ctx: ProviderContext): Promise<void>;   // receives http client, cache, logger, config
  healthCheck(): Promise<ProviderHealth>;      // cheap probe

  // core query — MUST be normalized + cache-aware + rate-limited by the base
  getFlightStatus(q: FlightStatusQuery): Promise<NormalizedFlightStatus | null>;

  // optional bulk (airport board) if the source supports it
  getAirportBoard?(q: AirportBoardQuery): Promise<NormalizedFlightStatus[]>;
}

type FlightStatusQuery =
  | { by: "flightNumber"; flightNumber: string; date: string; callsign?: string; icao24?: string }
  | { by: "route"; from: string; to: string; date: string };

type NormalizedFlightStatus = {
  flightNumber: string; airlineIata: string;
  origin: string; destination: string;            // IATA
  status: "scheduled"|"active"|"landed"|"delayed"|"cancelled"|"diverted"|"unknown";
  scheduledDeparture?: string; estimatedDeparture?: string; actualDeparture?: string;
  scheduledArrival?: string;  estimatedArrival?: string;  actualArrival?: string;
  gate?: string; terminal?: string; baggageBelt?: string;
  aircraftType?: string; registration?: string;
  source: string; fetchedAt: string; confidence: number;
};
```

- **Concrete providers** (`AeroDataBoxProvider`, `THYProvider`, `PegasusProvider`,
  `AJetProvider`, `LufthansaProvider`, `BritishAirwaysProvider`) implement only the *fetch + map*
  logic. **All cross-cutting
  behavior lives in a `BaseProvider`** they extend: HTTP client with timeout, retry/backoff,
  rate-limit token bucket, cache read-through, structured logging to `provider_logs`, and error
  wrapping. A provider author writes ~two methods: `fetchRaw()` and `normalize(raw)`.

## 8.5 Provider context & dependency injection

- Providers receive a `ProviderContext` at `init()`: `{ http, cache, logger, config, clock,
  rateLimiter }`. They **do not** construct their own clients or read env directly → fully
  testable and swappable.
- **DI strategy:** the `ProviderRegistry` is built at `apps/worker` bootstrap and injected into
  the provider-fetch service via `AppContext` (see [06](./06-backend-architecture.md) §6.5). Core
  code calls `registry.forAirline("TK")`, never `new THYProvider()`.
- **Test doubles:** a `FakeProvider` (fixture responses) is registered in tests; the pipeline
  runs with no network.

## 8.6 Automatic provider discovery

Two-layer discovery, config-gated:

1. **Static registration (compile-time):** each provider module self-registers by exporting a
   `providerFactory` and metadata. A build-time index (or explicit `providers/index.ts` barrel)
   enumerates all available providers. No dynamic `eval`/unsafe filesystem scanning in prod.
2. **Runtime activation (config/DB-driven):** the `providers` table + `settings` decide which
   registered providers are **enabled**. On boot, the registry loads enabled providers, calls
   `init()`, and maps `airlineIata → provider`. Adding an airline in prod = enable a row +
   deploy the module; disabling = flip `enabled` (no deploy).

```
Registry build:
  availableProviders (static barrel)
    ▶ filter by providers.enabled (DB) + settings flags
      ▶ init(ctx) each
        ▶ index by airlineIata → { "TK": thy, "PC": pegasus, "VF": ajet, "LH": lufthansa, "BA": ba }
```

Conflict rule: if two providers claim the same IATA, config `priority` decides; ties → log +
first-registered wins, surfaced in admin.

Wildcard providers may claim `airlineIata:["*"]`; the registry uses them as a fallback for
airlines without a more specific provider. The current global operations fallback is
`AeroDataBoxProvider`, enabled when `AERODATABOX_API_KEY` is configured or `aerodatabox` is listed
in `WORKER_ENABLED_PROVIDERS`.

## 8.7 Provider health monitoring

- **Per-provider circuit breaker** (closed → open → half-open): opens after `N` consecutive
  failures or error-rate over a window; while open, `getFlightStatus` returns cached-or-null
  fast (no calls); half-open probes with a single request.
- **Health scoring:** rolling p50/p95 latency, success rate, last-success timestamp →
  `up | degraded | down`, persisted to `providers.health` and shown on the admin board
  (see [03](./03-ux.md) §3.4.7).
- **Active probes:** scheduled `healthCheck()` (cheap) independent of user traffic.
- **`ProviderUpdated` on recovery/degradation** is emitted for observability.
- **Fallback chain:** if the airline's provider is down/absent → derive status from **position
  events** (takeoff/landing) with `source="derived:position"` and lower `confidence`; UI badges
  the source. The user still gets takeoff/landing; only gate/baggage-type fields are missing.

## 8.8 Caching & rate limiting (base behavior)

- **Read-through cache:** `getFlightStatus` first checks Redis (`provider:cache:<key>`, short
  TTL, e.g. 30–120s tuned per source), then `provider_cache` (DB, longer TTL, survives Redis),
  then fetches. Fresh responses populate both. See [09](./09-redis.md).
- **Rate limiting:** per-provider **token bucket** in Redis (distributed) so all worker
  replicas share one budget; requests beyond budget queue or serve stale-cache.
- **Coalescing:** concurrent requests for the same `cache_key` are de-duplicated (single-flight
  lock) so a spike doesn't multiply upstream calls.
- **Scheduling:** provider fetches are **BullMQ jobs** for actively-watched flights by default
  (`WORKER_PROVIDER_FETCH_SCOPE=watched`) so free-tier provider quota is not spent on every global
  ADS-B detection. `WORKER_PROVIDER_FETCH_SCOPE=all` enables all detected airline flights and
  should only be used with a paid quota/budget. Watch creation also enqueues an immediate
  cache-first fetch so the flight detail page can populate operations fields without waiting for a
  later detection cycle.

## 8.9 Compliance & politeness (hard requirements)

- Only **publicly available** status information is retrieved, **where permitted** by each
  source's terms. Provider `config` records the legal basis/endpoint; a provider must be
  disabled if terms disallow automated access.
- Respect `robots`, rate limits, and `Retry-After`. Identify with a proper `User-Agent` and
  contact where required. No credential sharing, no paywall circumvention, no scraping of
  data behind auth the user hasn't authorized.
- All provider traffic is logged (`provider_logs`) for audit and to prove polite behavior.
- Providers are **isolated**: a misbehaving provider cannot take down the core (timeouts +
  circuit breaker + separate job queue).

## 8.10 Example provider skeletons (design, not implementation)

- **`AeroDataBoxProvider`** (`key:"aerodatabox"`, `airlineIata:["*"]`): official marketplace API
  adapter for global operations status. It searches by ADS-B callsign first, then ICAO24, then
  flight number; maps status/gate/terminal/baggage/scheduled/estimated/actual times when the
  upstream response includes them. Capabilities: `{status,gate,baggage,schedule}`.
- **`THYProvider`** (`key:"thy"`, `airlineIata:["TK"]`): queries Turkish Airlines' public flight
  status by `flightNumber+date`; maps their status vocabulary → canonical enum; extracts gate/
  terminal/times. Capabilities: `{status,gate,schedule}`.
- **`PegasusProvider`** (`"pc"`? actual IATA `PC`, `airlineIata:["PC"]`): public status page.
- **`AJetProvider`** (`airlineIata:["VF"]`): public status.
- **`LufthansaProvider`** (`airlineIata:["LH"]`): public status (or official public API if a
  compliant one is available; config selects endpoint).
- **`BritishAirwaysProvider`** (`airlineIata:["BA"]`): public status.

Each defines: base URL(s), auth (usually none/public), parse strategy (JSON API preferred; HTML
parsing only where unavoidable and permitted), field mapping table, and known quirks.

## 8.11 Adding a new provider (developer checklist)

1. Create `packages/providers/src/<key>/` with `provider.ts` (extends `BaseProvider`),
   `normalize.ts`, `fixtures/`.
2. Implement `fetchRaw()` + `normalize()`; declare `key`, `airlineIata`, `capabilities`.
3. Add Zod schema for the raw response; `parse` in `fetchRaw`.
4. Register in the providers barrel; add a `providers` DB row (disabled by default).
5. Add golden fixture tests (raw → normalized) and a contract test (implements interface).
6. Enable via config in staging → validate on admin health board → enable in prod.

No core file changes required — that is the coupling guarantee.
