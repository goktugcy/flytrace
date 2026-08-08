# 18 — Production Readiness & Deployment

The app boots locally with zero external services (in-memory/mock adapters).
Production is mostly *enabling* adapters via environment + running migrations.
This file is the single checklist for that switch-over.

> **Rule:** never commit or log secrets. In production resolve them through
> `SECRET_PROVIDER=infisical|vault` (§7) rather than baking them into `.env`.

> **Production refuses to boot** on several misconfigurations rather than
> degrading silently — see §8.6. That is intentional: a rate limiter that
> quietly stopped being shared, or a `/metrics` endpoint that quietly went
> public, is worse than a failed deploy.

## 1. Required services
- **PostgreSQL + PostGIS** (`DATABASE_URL`). PostGIS is required (geography columns, GiST indexes).
  `pgcrypto` is also required — the migration runner creates it (needed by the
  `0005` token-hash backfill).
- **Redis** (`REDIS_URL`) — hot state, BullMQ queues, WS fan-out, rate-limit
  counters, MFA challenges. See §14 for what must survive a restart.
- Optional: **TimescaleDB** (§6), **PgBouncer** (§5), an **OTLP collector** (§7).

## 2. Database migrations
Generated migrations live in `packages/db/migrations/`.

```bash
bun run db:migrate      # apply committed migrations
bun run db:seed         # airlines, airports, providers, settings
```

**Application instances never migrate at boot.** A dedicated one-shot job runs
migrations and every service is gated on its exit code (§11). The runner also
takes a Postgres **advisory lock**, so two jobs started by accident serialise
instead of colliding; the second finds the schema current and exits 0.

- Regenerate after any `packages/db/src/schema/*.ts` change:
  `bun run db:generate` (runs the PostGIS geometry fix-up), then migrate.
- Timescale is opt-in: apply `migrations/timescale.optional.sql` by hand on a
  Timescale-enabled instance, then set `TIMESERIES_BACKEND=timescale`.

### 2.1 Migration `0005` — raw tokens → hashes (**breaking, irreversible**)
See §12 for the full rollout plan. In short: `sessions.token` and
`notification_channels.link_token` held the *raw* bearer value. `0005` computes
their SHA-256 digest **in place** and drops the plaintext columns.

- **Users are NOT signed out.** The digest is derived from the existing
  plaintext, so live cookies keep working.
- The migration is **irreversible**: rolling the schema back cannot recover raw
  tokens. That is the point.

## 3. Environment
`.env.example` is the authoritative list for local development;
`deploy/env/production.env.example` is the production template, where every
value with no safe default is marked `REQUIRED` and `docker compose up` fails
without it. Only `NEXT_PUBLIC_*` reaches the browser — never put a secret there,
it is inlined into JavaScript the browser downloads.

## 4. Realtime tracker & feed
- `TRACKER_SOURCE=adsb` (keyless, default) | `opensky` | `composite`.
- Lifecycle thresholds `TRACKER_{LIVE,DELAYED,STALE,REMOVE}_AFTER_MS` must strictly increase.
- **Tracker `/metrics`**: Prometheus scrape endpoint on `TRACKER_METRICS_PORT`
  (default `9101`, `0` disables) / `TRACKER_METRICS_HOST`. Keep it on the
  internal network — it is not token-guarded.
- **adsb.lol caps queries at ~250 NM** around the center; at low zoom the whole
  world does not arrive in one request. Known limit.

## 5. Database connection pooling
Toolkit in `packages/db/src/pool/`. Behind PgBouncer in **transaction** mode,
prepared statements break, so `PG_POOL_MODE=transaction` forces `prepare:false`.

### 5.1 Connection budget
`max_connections` must exceed the **sum of every pool** plus a reserve.

```
total = Σ (replicas × DB_POOL_MAX)  +  migration job (1)  +  superuser reserve (3)
        + your own psql/monitoring sessions
```

With the compose defaults and one replica each:

| service  | `DB_POOL_MAX` | replicas | connections |
|----------|---------------|----------|-------------|
| api      | 10            | 1        | 10 |
| tracker  | 5             | 1        | 5  |
| worker   | 5             | 1        | 5  |
| notifier | 5             | 1        | 5  |
| migrate  | 1 (transient) | –        | 1  |
| reserve  | –             | –        | 3  |
| **total**|               |          | **29** of `PG_MAX_CONNECTIONS=100` |

Scaling the API to 4 replicas costs 40, not 10. **Recompute this before every
scale-up** — exhausting `max_connections` takes down every service at once,
including the migration job you would need to fix it. Above ~100 total, put
PgBouncer in front rather than raising `max_connections`.

## 6. Timeseries (position history)
`packages/db/src/timeseries/`. `TIMESERIES_BACKEND=postgres` (default) works on
plain PostGIS; `timescale` adds `time_bucket` aggregation + retention/continuous
aggregates. Retention builders in `retention.ts`.

## 7. Secrets, tracing, email
- **Secrets**: `SECRET_PROVIDER=env` (default) | `infisical` (`INFISICAL_*`) | `vault` (`VAULT_*`).
  Remote adapters cache + fall back to env on miss/outage.
- **Tracing (OTel)**: `OTEL_TRACES_EXPORTER=noop` | `console` | `otlp`.
- **Email/digest**: `EMAIL_PROVIDER=mock` | `resend` | `brevo` | `smtp`.
  Digest scheduler gated by `DIGEST_ENABLED`.

---

## 8. Authentication & security

### 8.1 Sign-in flow (with MFA)
`POST /api/auth/sign-in` returns **either** a session **or** a challenge. It
never sets a session cookie for an account with MFA enabled.

```
POST /api/auth/sign-in  { email, password }
  │
  ├─ credentials invalid ────────────► 401  "invalid email or password"
  │                                    (identical for unknown user — no enumeration)
  ├─ MFA disabled ──────────────────► 200  { status: "authenticated", user }
  │                                    + Set-Cookie: flytrace_session, flytrace_refresh
  └─ MFA enabled ───────────────────► 200  { status: "mfa_required",
                                              challengeToken, expiresAt }
                                       NO cookies, NO session row

POST /api/auth/mfa/verify  { challengeToken, code }
  │  code = 6-digit TOTP or a backup code
  ├─ ok ────────────────────────────► 200  { status: "authenticated", user }
  │                                    + both cookies; backup code consumed
  ├─ wrong code ────────────────────► 401  attempt counted, challenge SURVIVES
  ├─ too many attempts ─────────────► 429  challenge burned
  └─ expired / used / other user ───► 401  "invalid or expired MFA challenge"
```

The challenge:
- 256-bit CSPRNG token; **only its SHA-256 digest is stored**, in Redis.
- TTL `MFA_CHALLENGE_TTL_SECONDS` (default 300, clamped 60–600).
- Single use, enforced by an atomic delete whose return value picks the winner.
- Concurrent verifications of one challenge are serialised by a short Redis
  lease — the loser gets `409`, so a backup code cannot be double-spent.
- `MFA_MAX_ATTEMPTS` (default 5) wrong codes burn it.
- If the MFA lookup itself errors, sign-in **fails closed** (500). A database
  blip must never be read as "this user has no MFA".

**Frontend:** the challenge token lives in React state only — never
localStorage/sessionStorage/cookie. Reloading the page during the second step
returns the user to the password form. That is the safe direction to fail: the
alternative is a half-authentication persisted to disk.

### 8.2 Refresh-token rotation and reuse
Two cookies with deliberately different scopes:

| cookie | path | purpose |
|---|---|---|
| `flytrace_session` | `/` | session bearer, sent on every API call |
| `flytrace_refresh` | `/api/auth` | rotation credential, **not** attached to ordinary API traffic |

Both `HttpOnly`, `Secure` outside local, `SameSite` per
`SESSION_COOKIE_SAMESITE` (default `Lax`).

`POST /api/auth/refresh` rotates in **one database transaction** that
`SELECT … FOR UPDATE`s the presented token, so two concurrent refreshes
serialise — one rotates, the other is reported as reuse. Without the row lock
both could mint a successor and silently fork the family, defeating detection.

**What happens on reuse** (a revoked token replayed):

| when | behaviour |
|---|---|
| within `REFRESH_TOKEN_REUSE_GRACE_MS` (default 10s) | rejected `401`, family **kept** — this is what a double-clicked button or a retried fetch looks like, and the client still holds the successor |
| after the grace window | the token leaked: **the whole family is revoked, every other refresh token for the user is revoked, every session is destroyed**, an `auth.refresh_token_reuse_detected` audit record is written, and the user is emailed |

Set `REFRESH_TOKEN_REUSE_GRACE_MS=0` to treat every replay as an attack.

### 8.3 Device management
On every successful authentication the calling device is registered or
refreshed. A device is a SHA-256 fingerprint of `user-agent + coarse IP`
(coarse so an address change does not fork one device into many rows).

- A first sighting writes an `auth.new_device` audit event and sends an
  out-of-band notification.
- `assessLogin` scores the login (`new_device`, `new_ip_prefix`,
  `impossible_travel` → low/medium/high) and the verdict is audited.
- `DELETE /api/v1/security/devices/:id` revokes **both** the device's refresh
  tokens and its sessions. Revoking one without the other leaves a foothold.

**IP storage** — `SECURITY_IP_STORAGE`:

| value | stored | notes |
|---|---|---|
| `prefix` *(default)* | `/24` (v4), `/48` (v6) | keeps the "new network?" signal without retaining an exact address; survives CGNAT/mobile churn |
| `full` | exact address | only where a regulator or fraud process requires it |
| `none` | nothing | new-device detection still works via the user-agent half |

### 8.4 Session invalidation

| event | endpoint | sessions | refresh tokens | notified |
|---|---|---|---|---|
| sign-out | `POST /api/auth/sign-out` | current | current | – |
| sign-out all devices | `POST /api/auth/sign-out-all` | all | all | – |
| **password change** | `POST /api/v1/security/password` | all | all | yes |
| **MFA disabled** | `POST /api/v1/security/mfa/disable` | all | all | yes |
| device revoked | `DELETE /api/v1/security/devices/:id` | that device | that device | – |
| refresh-token reuse | (automatic) | all | all | yes |

Password change and MFA reset revoke everything because both mean "the set of
people who can authenticate as this account just changed" — leaving old sessions
alive makes a password change useless against an attacker who already holds a
session cookie. The caller is signed out too and must re-authenticate.

`POST /api/v1/security/password` takes `{currentPassword, newPassword}`,
re-verifies the current password (so a stolen session cookie alone cannot change
it), and is rate-limited under the `passwordReset` policy because it is a
credential-guessing surface from *inside* the account.

`GET /api/v1/security/sessions` lists the caller's active sessions — id, device,
coarsened IP, user-agent, timestamps. No token material, by construction: the
database only holds digests.

**Housekeeping.** Expiry is enforced at read time, so an expired row is already
unusable. The worker additionally reaps them on
`SECURITY_JANITOR_INTERVAL_MS` (default 1h) so `sessions` and
`notification_channels` do not grow without bound — see
`apps/worker/src/security-janitor.ts`.

### 8.5 Token storage
**No raw bearer token is stored anywhere.** One shared utility
(`@flytrace/shared` → `hashToken`, SHA-256) is used by every module:

| token | stored as |
|---|---|
| session cookie | `sessions.token_hash` |
| refresh token | `refresh_tokens.token_hash` |
| email verification link | `notification_channels.link_token_hash` + expiry |
| Telegram deep link | `notification_channels.link_token_hash` + expiry |
| MFA challenge | Redis key = digest |
| MFA backup codes | scrypt (deliberate exception — human-typable, low entropy) |
| passwords | argon2id (never conflated with the above) |

A fast digest is correct for the first five: the tokens carry ≥256 bits of
entropy so there is nothing to brute-force, and a salted KDF could not be looked
up by hash. Comparisons use `timingSafeEqual`.

### 8.6 Production boot guards
The API **refuses to start** when:

| condition | why |
|---|---|
| `RATE_LIMIT_BACKEND=memory` | per-process counters multiply every limit by the replica count |
| `RATE_LIMIT_BACKEND=redis` with no client | same, silently |
| `MFA_CHALLENGE_BACKEND=memory` | a challenge issued by one replica is invisible to the next |
| `INTERNAL_API_TOKEN` missing (staging/production) | `/metrics` and `/health/detailed` would be public |
| `INTERNAL_API_TOKEN` shorter than 32 chars | brute-forceable |
| invalid `RATE_LIMIT_BACKEND` value | config typo |

Outside production these degrade with a **loud warning** instead. Local
fallbacks that are *forbidden* in production: in-memory rate limiter, in-memory
MFA challenge store, open `/metrics`, `MockTurnstile`.

### 8.7 Rate limiting
One limiter is built at the composition root and shared by every route; no
module constructs its own. Keys are hashed (`hashKeyComponent`), so no raw IP,
email or user id is ever concatenated into a Redis key — that closes key
injection and keeps PII out of Redis.

Credential endpoints bucket by **both** IP and identifier: keying on IP alone
lets a botnet spread a password-spray; keying on the identifier alone lets an
attacker lock a victim out.

| policy | default | window | on limiter failure |
|---|---|---|---|
| `api` (general) | 100 | 60s | fail-**open** |
| `login` | 10 | 5m | fail-**closed** |
| `signup` | 5 | 1h | fail-**closed** |
| `mfaChallenge` † | 10 | 5m | fail-**closed** |
| `mfaVerify` | 10 | 5m | fail-**closed** |
| `refresh` | 60 | 5m | fail-**closed** |
| `passwordReset` | 5 | 1h | fail-**closed** |
| `wsTicket` | 30 | 60s | fail-**closed** |
| `security` | 20 | 60s | fail-**closed** |
| `admin` | 60 | 60s | fail-**closed** |
| `ops` | 120 | 60s | fail-**open** |

† `mfaChallenge` is enforced **inside** the sign-in flow, not in route
middleware, and is keyed by user id. Whether a challenge gets issued is only
known after the password verifies, so a middleware could not see it — and
without the cap, an attacker holding one valid password could mint challenges
indefinitely (each a Redis write) while still failing the second factor.

Fail-closed on credentials: losing the shared counter means losing the only
defence against online guessing, so we return `503` rather than serve unlimited
attempts. Fail-open on reads and monitoring: a Redis blip should not black out
the product or hide it from the dashboard.

Responses carry `RateLimit-Limit/Remaining/Reset` (and the legacy
`X-RateLimit-*`); `429` adds `Retry-After` in seconds.

### 8.8 Other hardening
- **Turnstile** on sign-up: `TURNSTILE_ENABLED` + `TURNSTILE_SECRET` (server),
  `NEXT_PUBLIC_TURNSTILE_*` (widget). Without a secret it runs a permissive mock
  — dev only; boot fails if enabled without a secret outside local.
- **CSP**: per-request nonce from `apps/web/middleware.ts`; API responses carry
  their own. Violations post to `/api/v1/security/csp-report`.
- **Audit log**: `AUDIT_BACKEND=db` in production. Records carry the coarsened
  IP and never a token, password or code.

## 9. Monitoring & health

| endpoint | exposure | contents |
|---|---|---|
| `GET /health` | **public** | liveness only — `{status:"ok"}`. Probes **no** dependencies. |
| `GET /health/ready` | **public** | `{ready, checks:{db,redis}}` — minimal, 200/503 |
| `GET /ready` | **public** | alias of the above, for existing probes |
| `GET /health/detailed` | **internal** | every check + latency |
| `GET /metrics` | **internal** | Prometheus exposition |

**Liveness must not probe dependencies.** A liveness probe that fails during a
database outage makes the orchestrator restart healthy processes and turns a
dependency blip into a crash loop. Point `livenessProbe` at `/health` and
`readinessProbe` at `/health/ready`.

Internal access is layered:
1. **network** — internal listeners have no published ports;
2. **proxy** — `deploy/nginx/flytrace.conf` `403`s these paths for non-internal
   source addresses;
3. **app** — `INTERNAL_API_TOKEN` via `Authorization: Bearer` or
   `X-Internal-Token`, compared in constant time.

The token is **never** accepted from a query string (that lands in proxy logs,
browser history and `Referer`). A missing or wrong token returns **404, not
401** — a 401 confirms the endpoint exists.

`/health/detailed` responses are sanitised: only structured summaries
(`depth=`, `connections=`, `heap …`) pass through; any other free text (a driver
error naming a host, a stack) is reduced to `unavailable`. No connection string,
Redis URL, secret, internal hostname or user data can appear.

Scrape example:
```bash
curl -H "Authorization: Bearer $INTERNAL_API_TOKEN" https://api.example.com/metrics
```

## 10. WebSocket multi-node scaling
Single-node runs on `RedisFanout` + connection rate limiter + presence +
heartbeat. The **sharded** path (`apps/api/src/ws/scaling/`) is built and
unit-tested but intentionally not wired into the live fan-out — it only pays off
at ≥2 API nodes. To enable: publish `PositionUpdated` to
`ShardManager.channelFor(...)`, subscribe shard channels per viewport, set
`WS_PUBSUB_BACKEND=redis` / `WS_PRESENCE_BACKEND=redis`, tune `WS_SHARD_COUNT`,
then load-test with `load/`.

---

## 11. Docker deployment

```
deploy/
  Dockerfile.bun        parametric: api | tracker | worker | notifier
  Dockerfile.web        Next.js standalone
  Dockerfile.migrate    one-shot migration job
  docker-bake.hcl       build everything with one command
  nginx/flytrace.conf   reverse proxy
  env/production.env.example
docker-compose.production.yml
```

### 11.1 Build

```bash
docker buildx bake -f deploy/docker-bake.hcl                    # all images
docker buildx bake -f deploy/docker-bake.hcl api --load         # just one
```

Image properties:
- multi-stage; runtime layer holds **only** the bundled `dist/index.js`
  (+ source map) — no `node_modules`, no source, no lockfile, no `.env`
- `bun install --frozen-lockfile` — a build fails rather than resolving a
  dependency graph nobody reviewed
- **non-root** (`bun` / `node`, uid 1000)
- `tini` as PID 1 → SIGTERM reaches the process → the existing graceful-shutdown
  handler drains the server, closes consumers and the pool
- compatible with `--read-only` root filesystem (`HOME`/Bun cache → `/tmp`)
- `HEALTHCHECK` hits `/health` (liveness), never `/health/ready`
- ~105 MB per service, 294 MB web

### 11.2 Run

```bash
cp deploy/env/production.env.example .env.production
# fill in every REQUIRED value:  openssl rand -hex 32
docker compose -f docker-compose.production.yml --env-file .env.production up -d
```

### 11.3 Startup ordering
`depends_on` alone is **not** readiness — it waits only for container creation.
Every edge uses a condition:

```
postgres (healthy) ──┐
redis    (healthy) ──┼──► migrate (runs once, must exit 0)
                     │        │
                     │        └──► api ──► web ──► proxy
                     └───────────► tracker, worker, notifier
```

If the migration job fails, **no application container starts**.

### 11.4 Networks and exposure
Two networks. Only the **proxy** publishes ports. Postgres and Redis are on
`internal` with **no** published ports — reach them with
`docker compose exec postgres psql`.

### 11.5 Reverse proxy
`deploy/nginx/flytrace.conf` handles TLS termination, HTTP→HTTPS, WebSocket
upgrade (1h read timeout, buffering off), a 1 MB body limit, security headers,
and blocks `/metrics` + `/health/detailed` from the public internet.

**Real client IP matters for security, not just logs.** Address headers are
client-settable; forwarded verbatim, anyone could land in a different rate-limit
bucket every request.

The config is written for **Cloudflare**:

- `set_real_ip_from` lists Cloudflare's published IPv4 + IPv6 ranges
  (`cloudflare.com/ips-v4` / `-v6`, fetched 2026-08-08). Re-check them when you
  touch the file.
- `real_ip_header CF-Connecting-IP` — behind Cloudflare this is the right input:
  a single address Cloudflare determined and overwrites. `X-Forwarded-For` is a
  client-influenced list Cloudflare only appends to, and parsing it correctly
  needs `real_ip_recursive` plus a complete trusted list — wrong the moment
  either drifts.
- The proxy then **overwrites** `CF-Connecting-IP`, `X-Forwarded-For` and
  `X-Real-IP` with the address it resolved. Overwriting `CF-Connecting-IP`
  matters because the app reads it first (`clientIp`); nginx forwards inbound
  headers untouched by default, so without that line a request arriving from a
  non-Cloudflare address could forge it.

**This holds only if the origin is unreachable except through Cloudflare.**
Restrict the origin firewall to those ranges, or use `cloudflared` /
Authenticated Origin Pulls. An attacker who finds the origin IP bypasses
Cloudflare entirely and no header configuration helps.

Behind a different edge (ALB, direct), both the range list and `real_ip_header`
must change — see the comments at the top of the file.

---

## 12. Rollout plan for the token-hash migration

**What changes:** `sessions.token` → `sessions.token_hash`,
`notification_channels.link_token` → `link_token_hash` (+ expiry).

**Do users have to sign in again?** **No.** `0005` derives each digest from the
existing plaintext in place, so live cookies keep working. Verified against a
seeded database.

**Order of operations** (the old and new code cannot share a schema — old code
reads `sessions.token`, which `0005` drops):

1. Take a backup (§13). This migration is not reversible.
2. Stop the old application containers, or scale to zero.
3. Run the migration job. It holds an advisory lock; a second job waits.
4. Verify:
   ```sql
   select count(*) from information_schema.columns
    where (table_name='sessions' and column_name='token')
       or (table_name='notification_channels' and column_name='link_token');
   -- must be 0
   ```
5. Start the new containers.

**Zero-downtime?** Not for this one. It is a destructive column swap, so there
is no window in which both versions run correctly. Expect a short maintenance
window sized by the `UPDATE` over `sessions` (seconds for a normal table).

To make it zero-downtime you would need a three-deploy expand/contract:
add `token_hash` → deploy code that writes both and reads either → backfill →
deploy code that reads only the hash → drop `token`. That is the right shape for
a large or always-on deployment; it was not worth three deploys here.

**Rollback risk.** Rolling the *schema* back is not possible — the plaintext is
gone by design. Rolling the *application* back requires re-adding an empty
`token` column, which signs everyone out (every session lookup misses). Decide
before you deploy: the realistic rollback is "roll forward with a fix".

**If you prefer a clean break** over migrating tokens, replace the two `UPDATE`
statements in `0005` with `DELETE FROM sessions;`. Every user signs in again —
simpler, and defensible if you suspect the old plaintext was ever exposed.

## 13. Backup & restore

`apps/worker/src/backup/`. `BACKUP_PROVIDER=mock` (default) | `pgdump`
(`BACKUP_DIR`, `WAL_ARCHIVE_DIR`, `PG_DUMP_BIN`/`PG_RESTORE_BIN`).
`BackupManager` supports backup / restore / integrity-verify.

Backups live on a **separate volume** (`pgbackup`) from the database
(`pgdata`), so recreating the database volume does not destroy the only copy.

### 13.1 Manual backup
```bash
docker compose -f docker-compose.production.yml exec postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f /backups/flytrace-$(date +%F).dump

# copy it OFF the host — a backup on the same machine is not a backup
docker compose -f docker-compose.production.yml cp \
  postgres:/backups/flytrace-$(date +%F).dump ./
```

### 13.2 Restore
```bash
# 1. stop everything that writes
docker compose -f docker-compose.production.yml stop api tracker worker notifier

# 2. restore (--clean drops existing objects first)
docker compose -f docker-compose.production.yml exec -T postgres \
  pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists \
  /backups/flytrace-2026-07-31.dump

# 3. re-apply migrations — the dump may predate the current schema
docker compose -f docker-compose.production.yml run --rm migrate

# 4. restart
docker compose -f docker-compose.production.yml start api tracker worker notifier
```

### 13.3 Verify restores
An untested backup is not a backup. Restore into a scratch database quarterly
and check row counts + a login:
```bash
createdb flytrace_restore_test && pg_restore -d flytrace_restore_test the.dump
psql flytrace_restore_test -c "select count(*) from users;"
```

### 13.4 What is *not* in the database
Redis holds the BullMQ queues and consumer groups. A Redis loss drops in-flight
jobs; it does not lose durable data. See §14.

## 14. Redis usage and persistence

| workload | key space | rebuildable? |
|---|---|---|
| hot flight state, pub/sub fan-out | `rt:*`, `flight:state:*` | **yes** — the tracker refills it in seconds |
| BullMQ queues + consumer groups | `stream:*`, `bull:*` | **no** — losing these drops in-flight jobs |
| rate-limit counters | `rl:*` | yes (limits briefly reset) |
| MFA challenges | `mfa:chal:*` | yes (users re-enter their password) |
| WS ticket replay guard | `idem:wsjti:*` | yes |

Because the queues matter, production runs **AOF on** with `everysec` fsync.

**Eviction policy is `noeviction`, not `allkeys-lru`.** LRU can evict a queue
key under memory pressure and silently drop jobs; `noeviction` makes Redis
refuse writes instead, which is a loud failure you can alert on. **Alert on
`used_memory` approaching `maxmemory`** — with `noeviction` that is your only
warning.

Production also sets `requirepass`, publishes no ports, and renames
`FLUSHALL`/`FLUSHDB`/`CONFIG` to empty.

**One instance or two?** A single instance with these settings is fine to start.
Split the queues onto their own instance when either (a) cache/hot-state churn
starts competing with queue durability for memory, or (b) you want different
persistence settings per workload. Prefer **separate instances over logical DB
numbers** — `SELECT n` shares one memory limit, one eviction policy and one
`maxmemory`, so the isolation is illusory.

## 15. Deployment caveats
- **Web must run on Node, not Bun.** `bunx next start` fails with
  `EvalError: Code generation from strings disallowed` because
  `apps/web/middleware.ts` runs in Bun's Edge-runtime emulation.
  `deploy/Dockerfile.web` therefore uses `node:22-alpine`. `bun run dev` is
  unaffected.
- **AeroDataBox** operations fields only populate when the provider matches the
  callsign/flight-number; free tier prefers `WORKER_PROVIDER_FETCH_SCOPE=watched`.
- **Historical trail** before an aircraft was first seen exists only if our DB
  captured positions.

## 16. Pre-deploy verification

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
bun run db:migrate && bun run db:seed
bun run build
docker buildx bake -f deploy/docker-bake.hcl
```

CI (`.github/workflows/ci.yml`) runs all of it plus: migration idempotency, a
SQL assertion that no plaintext token column survived, an integration smoke test
across the whole backbone, a check that no server secret name appears in the
client bundle, and container assertions (non-root, no `.env`/lockfile in the
image, internal endpoints closed without a token, graceful shutdown on SIGTERM).
