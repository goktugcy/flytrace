# 18 — Production Readiness & Deployment Checklist

Everything below is **code-complete and opt-in**: the app boots and runs locally
with zero external services (in-memory/mock adapters). Going to production is
mostly *enabling* adapters via environment + running migrations. This file is
the single checklist for that switch-over.

> Rule: never commit or log secrets/API keys. In production resolve them through
> `SECRET_PROVIDER=infisical|vault` (see §7) rather than baking them into `.env`.

## 1. Required services
- **PostgreSQL + PostGIS** (`DATABASE_URL`). PostGIS is required (geography columns, GiST indexes).
- **Redis** (`REDIS_URL`) — hot state, BullMQ queues, WS fan-out.
- Optional: **TimescaleDB** (position history, §6), **PgBouncer** (§5), an **OTLP collector** (§8).

## 2. Database migrations
Generated migrations live in `packages/db/migrations/` (`0000`–`0003` + `timescale.optional.sql`).
```
cd packages/db && bun run db:migrate      # apply committed migrations (incl. security + airspace tables)
```
- New tables since Phase 3: `geofences`, `user_mfa`, `mfa_backup_codes`,
  `refresh_tokens`, `user_devices`, `audit_log`.
- Timescale is **opt-in**: only apply `migrations/timescale.optional.sql` by hand
  on a Timescale-enabled instance, then set `TIMESERIES_BACKEND=timescale`.
- After changing any `packages/db/src/schema/*.ts`, regenerate with
  `bun run db:generate` (runs the PostGIS geometry fix-up) before migrating.

## 3. Environment
`.env.example` is the authoritative list (95 keys). Everything has a safe local
default; production overrides the categories below. Only `NEXT_PUBLIC_*` reaches
the browser.

## 4. Realtime tracker & feed
- `TRACKER_SOURCE=adsb` (keyless, default) | `opensky` | `composite`.
- Lifecycle thresholds `TRACKER_{LIVE,DELAYED,STALE,REMOVE}_AFTER_MS` must strictly increase.
- **Tracker `/metrics`**: the tracker now exposes a Prometheus scrape endpoint —
  `TRACKER_METRICS_PORT` (default `9101`, `0` disables) / `TRACKER_METRICS_HOST`.
  Scrape `http://<tracker>:9101/metrics`; `/health` + `/ready` for liveness.
- **adsb.lol caps queries at ~250 NM** around the center. At low zoom the whole
  world does not arrive in one request — acceptable known limit.

## 5. Database connection pooling (PgBouncer)
Toolkit in `packages/db/src/pool/`. Behind PgBouncer in **transaction** mode,
prepared statements break, so:
- `PG_POOL_MODE=transaction` forces `prepare:false` automatically.
- Swap `createDb(...)` → `createPooledDb({ url, ...resolvePoolConfig(process.env) })`
  at the DB composition site; use `withTransaction(db, fn)` for multi-statement work.
- `PG_POOL_MAX` sizes the local postgres-js pool.

## 6. Timeseries (position history)
`packages/db/src/timeseries/`. `TIMESERIES_BACKEND=postgres` (default) works on
plain PostGIS; `timescale` adds `time_bucket` aggregation + retention/continuous
aggregates (apply the optional SQL first). Retention builders in `retention.ts`.

## 7. Secrets, tracing, email (opt-in adapters)
- **Secrets**: `SECRET_PROVIDER=env` (default) | `infisical` (`INFISICAL_*`) | `vault` (`VAULT_*`).
  Remote adapters cache + fall back to env on miss/outage.
- **Tracing (OTel)**: `OTEL_TRACES_EXPORTER=noop` (default) | `console` | `otlp`
  (+ `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`). API wraps requests in a span.
- **Email/digest**: `EMAIL_PROVIDER=mock` (default) | `resend` | `brevo` | `smtp`
  (`EMAIL_API_KEY` / `BREVO_API_KEY` / `SMTP_URL`). Digest scheduler gated by
  `DIGEST_ENABLED` (default false).

## 8. Security hardening
- **MFA (TOTP)**: code-complete (`user_mfa` / `mfa_backup_codes` + repos + routes).
  `MFA_SECRET_ENCRYPTION_KEY` (falls back to `AUTH_SECRET`) encrypts secrets at rest.
- **Refresh-token rotation + device mgmt + suspicious-login**: `SESSION_REFRESH_TTL_DAYS`,
  `IMPOSSIBLE_TRAVEL_MAX_KMH`.
- **Turnstile** (bot protection on sign-up): enable with
  `TURNSTILE_ENABLED=true` + `TURNSTILE_SECRET` (server) and
  `NEXT_PUBLIC_TURNSTILE_ENABLED=true` + `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (web widget).
  Without a secret it runs a permissive mock (dev-safe). `TURNSTILE_FAIL_OPEN` controls
  behavior on verifier outage.
- **CSP**: enforced by `apps/web/middleware.ts` (`buildCsp`, per-request origins) — tighten
  `connect-src`/`img-src`/`script-src` via its env inputs (`CSP_*`, `NEXT_PUBLIC_API_URL`,
  `NEXT_PUBLIC_MAP_STYLE`). API responses also carry a CSP (`buildApiCsp`). CSP violations
  can be posted to `/api/v1/security/csp-report`.
- **Rate limiting**: HTTP `RATE_LIMIT_BACKEND=memory|redis`, `RATE_LIMIT_MAX`,
  `RATE_LIMIT_WINDOW_MS`; WS `WS_MAX_CONNS_PER_IP`, `WS_MAX_MSGS_PER_SEC`.
- **Audit log**: `AUDIT_BACKEND=memory|db` (`audit_log` table).

## 9. Monitoring & health
- API: `/health`, `/ready`, `/metrics` (Prometheus), `/health/detailed` (db/redis/queue/ws/memory JSON).
- Tracker: `/metrics` + `/health` on `TRACKER_METRICS_PORT` (§4).

## 10. WebSocket multi-node scaling (the remaining wiring)
Single-node runs today on `RedisFanout` (every API node receives every event) +
`ConnectionRateLimiter` + presence + heartbeat (all wired in `ws/gateway.ts`).
The **sharded** path (`apps/api/src/ws/scaling/`: `ShardManager`, `PubSubAdapter`,
`InMemory`/`Redis` presence) is built + unit-tested but intentionally **not wired
into the live fan-out** — it only pays off at ≥2 API nodes and rewiring the
working pipeline single-node adds risk for no benefit. To enable at scale:
1. Publishers (tracker/worker) publish each `PositionUpdated` to
   `ShardManager.channelFor(shardForPoint(lat, lon))` instead of the single bus channel.
2. Gateway subscribes/unsubscribes shard channels per connection viewport
   (`shards.assign(connId, bbox)`), node-level refcounted, and routes to local sockets.
3. Set `WS_PUBSUB_BACKEND=redis`, `WS_PRESENCE_BACKEND=redis`, tune `WS_SHARD_COUNT`.
4. Load-test with `load/` (k6: `ws-connections`, `aircraft-stream`; profiles 1k/5k/10k/50k).

## 11. Disaster recovery / backup
`apps/worker/src/backup/`. `BACKUP_PROVIDER=mock` (default) | `pgdump`
(`BACKUP_DIR`, `WAL_ARCHIVE_DIR`, `PG_DUMP_BIN`/`PG_RESTORE_BIN`). `BackupManager`
supports backup / restore / integrity-verify; wire a nightly cron entrypoint.

## 12. Deployment caveats
- **Web `next start` under Bun + Edge middleware**: `bunx next start` fails with
  `EvalError: Code generation from strings disallowed` because `apps/web/middleware.ts`
  runs in Bun's Edge-runtime emulation. `bun run dev` is unaffected. Deploy the web
  on a **Node runtime** (`node .next/standalone`/Vercel) or move the CSP/security logic
  out of Edge middleware into `next.config` `headers()` if you must serve via Bun.
- **AeroDataBox** operations fields only populate when the provider matches the
  callsign/flight-number; free tier prefers `WORKER_PROVIDER_FETCH_SCOPE=watched`.
- **Historical trail** before the aircraft was first seen exists only if our DB
  captured positions — upstream ADS-B viewport APIs don't return full history.

## 13. Pre-deploy verification
```
bun run typecheck && bun run lint && bun test && bun run build
```
All green as of this document (typecheck 10/10, lint clean, 606 tests).
