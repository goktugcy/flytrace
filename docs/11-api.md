# 11 — API

The HTTP API is served by `apps/api` (Bun + Hono). It is the only ingress for frontends and
integrations. REST for request/response; WebSocket for realtime ([12](./12-websocket.md)). All I/O is
Zod-validated; types are shared with the frontend via `packages/shared`.

## 11.1 Conventions

- **Base:** `/api/v1` (versioned; see §11.9). JSON only (`application/json`).
- **Auth:** Better Auth session cookie (httpOnly, SameSite=Lax, Secure) for the web app;
  optional bearer for admin tooling. See [15](./15-security.md).
- **IDs:** UUID v7 in responses; human routes use natural keys (`callsign/date`, `iata`, `reg`).
- **Casing:** JSON `camelCase`; timestamps ISO-8601 UTC; units explicit (`altitudeFt`,
  `groundSpeedKt`, `distanceKm`).
- **Idempotency:** unsafe POSTs that create resources accept an `Idempotency-Key` header.
- **Validation:** every request (params, query, body) parsed by a Zod schema; failures →
  `422` with field errors.
- **Contracts as SSOT:** each route has a Zod request+response schema in
  `packages/shared/contracts`; an **OpenAPI** doc is generated from them (Hono + zod-openapi).

## 11.2 Standard response envelopes

**Success**
```
{ "data": <payload>, "meta": { "requestId": "...", "cached": false } }
```
**Error**
```
{ "error": { "code": "FLIGHT_NOT_FOUND", "message": "…", "details": {…}, "requestId": "…" } }
```
- `code` is a stable machine string; `message` is human copy; `details` optional (e.g. Zod
  field errors). Same envelope everywhere → one client error handler.

## 11.3 Error model & status codes

| Status | Code examples | When |
|--------|---------------|------|
| 400 | `BAD_REQUEST` | malformed request |
| 401 | `UNAUTHENTICATED` | missing/invalid session |
| 403 | `FORBIDDEN` | authenticated but not allowed (role/ownership) |
| 404 | `NOT_FOUND`, `FLIGHT_NOT_FOUND` | resource missing |
| 409 | `CONFLICT`, `ALREADY_WATCHING` | state conflict |
| 422 | `VALIDATION_ERROR` | Zod validation failed (details = fields) |
| 429 | `RATE_LIMITED` | over limit (+ `Retry-After`, `X-RateLimit-*`) |
| 5xx | `INTERNAL`, `UPSTREAM_UNAVAILABLE` | server/provider failure (retryable flag) |

Errors derive from the typed `AppError` hierarchy ([06](./06-backend-architecture.md) §6.6); never leak
stack traces or SQL.

## 11.4 Pagination, filtering, sorting

- **Cursor pagination** (default) for feeds/lists: `?limit=50&cursor=<opaque>` →
  `meta.nextCursor`. Cursors are opaque base64 of `(sortKey,id)`.
- **Offset** only for admin tables where total counts matter (`?page=&pageSize=`).
- **Filtering:** explicit whitelisted params per endpoint (never arbitrary SQL); `?status=`,
  `?airline=`, `?bbox=`.
- **Sorting:** `?sort=-departureTime` (whitelisted fields).

## 11.5 Caching & conditional requests

- Read endpoints set `Cache-Control` + `ETag`; support `If-None-Match` → `304`.
- Hot reads (flight summary, airport board) served from Redis; `meta.cached` + `Age` conveyed.
- Search + catalog responses cached (see [09](./09-redis.md) §9.3).

## 11.6 Endpoint surface (v1)

### Auth (delegated to Better Auth handlers, mounted under `/api/auth/*`)
`POST /api/auth/sign-up`, `/sign-in`, `/sign-out`, `GET /api/auth/session`, OAuth callbacks,
email verification, password reset. (Shapes owned by Better Auth; see [15](./15-security.md).)

### Public — flights
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/v1/flights/search?q=&type=` | typeahead/search (flightNo/route/airport) |
| GET | `/api/v1/flights/:callsign/:date` | full flight detail (live + timeline + cards) |
| GET | `/api/v1/flights/:callsign/:date/track` | position track (downsampled by default) |
| GET | `/api/v1/flights/:callsign/:date/events` | derived + provider events (timeline) |
| GET | `/api/v1/flights/live?bbox=&airline=&alt=` | live flights in a viewport (map bootstrap) |

### Public — airports
| GET | `/api/v1/airports/:iata` | airport detail (runways, stats, geo) |
| GET | `/api/v1/airports/:iata/departures?cursor=` | departures board (live status) |
| GET | `/api/v1/airports/:iata/arrivals?cursor=` | arrivals board |

### Public — aircraft
| GET | `/api/v1/aircraft/:reg` (or `/hex/:icao24`) | aircraft detail + recent flights |
| GET | `/api/v1/aircraft/:reg/flights?cursor=` | flight history for the aircraft |

### Public — stats (landing page)
| GET | `/api/v1/stats/live` | live counters (flights now, events today, notifs sent) |

### User (authenticated)
| GET/POST | `/api/v1/watchlist` | list / create watch (flight or matcher + events + channels) |
| PATCH/DELETE | `/api/v1/watchlist/:id` | update rules / remove |
| GET/POST/DELETE | `/api/v1/favorites[/:id]` | routes/aircraft/airports |
| GET | `/api/v1/notifications?cursor=` | notification history feed |
| GET/PATCH | `/api/v1/settings` | profile, units, locale, quiet hours, default channels |
| GET | `/api/v1/channels` | connected channels + verification state |
| POST | `/api/v1/channels/telegram/link` | mint link token → returns deep link |
| POST | `/api/v1/channels/webpush/subscribe` | store push subscription |
| POST | `/api/v1/channels/email/verify` | trigger/confirm email verification |
| DELETE | `/api/v1/channels/:id` | disconnect a channel |
| GET | `/api/v1/dashboard` | aggregated dashboard payload (tracked flights + recent notifs) |

### Admin (role=admin)
| GET | `/api/v1/admin/providers` | provider health board |
| POST | `/api/v1/admin/providers/:key/recheck` \| `/toggle` | ops actions |
| GET | `/api/v1/admin/queues` | queue depths/throughput/failed |
| POST | `/api/v1/admin/queues/:name/dlq/retry` | replay DLQ items |
| GET | `/api/v1/admin/cache` | cache stats |
| GET | `/api/v1/admin/flights` | live flight monitoring |
| GET | `/api/v1/admin/debug/flights/:icao24` | active hot-state debug for one aircraft |
| GET | `/api/v1/admin/logs?level=&module=&correlationId=` | log search |
| GET | `/api/v1/admin/stats` | platform statistics time-series |
| GET | `/api/v1/admin/audit?entity=&actor=` | audit log |

### System
| GET | `/health` (liveness), `/ready` (readiness: DB+Redis) | orchestration probes |
| GET | `/metrics` | Prometheus metrics (internal network only) |
| GET | `/api/v1/openapi.json` | generated OpenAPI spec |

## 11.7 Representative payloads (design)

**GET `/api/v1/flights/TK1980/2026-07-17`**
```
{ "data": {
  "flight": { "callsign":"THY1980","flightNumber":"TK1980","status":"active",
    "route": { "from": {"iata":"IST","name":"Istanbul"}, "to": {"iata":"LHR",...} },
    "schedule": { "scheduledDeparture":"...","estimatedArrival":"...","actualDeparture":"..." } },
  "live": { "lat":41.9,"lon":28.1,"altitudeFt":37000,"headingDeg":295,
            "groundSpeedKt":455,"verticalRateFpm":0,"onGround":false,
            "distanceFlownKm":210,"distanceRemainingKm":2200,"etaUtc":"..." },
  "aircraft": { "registration":"TC-JJE","typeIcao":"B77W","typeName":"Boeing 777-300ER" },
  "timeline": [ {"type":"takeoff","occurredAt":"...","confidence":0.98,"source":"derived:position"} ],
  "watching": true
}, "meta": { "requestId":"...", "cached": false } }
```

**POST `/api/v1/watchlist`** (body)
```
{ "match": { "flightNumber":"TK1980", "date":"2026-07-17" },
  "eventTypes": ["takeoff","landing","gate_change","delay"],
  "channels": ["telegram","webpush"] }
```

## 11.8 Rate limiting (surface)

- Tiered: anonymous (per IP) < authenticated (per user) < admin. Search + live endpoints have
  their own stricter buckets. Headers `X-RateLimit-Limit/Remaining/Reset`; `429 + Retry-After`.
  Enforced via Redis (see [09](./09-redis.md) §9.9, [15](./15-security.md)).

## 11.9 Versioning & deprecation

- URL-versioned (`/v1`). Additive changes are non-breaking within a version. Breaking changes →
  `/v2` with an overlap window; deprecations announced via `Deprecation`/`Sunset` headers.
- Generated OpenAPI + typed client (`packages/shared`) keep FE/BE in lockstep; a contract test
  fails CI if a response diverges from its schema ([16](./16-testing.md)).

## 11.10 Middleware chain (order)

`requestId → logger → CORS → security headers → body limit → auth (session) → rate limit →
zod-validate → handler → error mapper → response serializer`. Each is a small Hono middleware;
admin routes add a `requireRole('admin')` guard; owner-scoped routes add `requireOwnership`.
