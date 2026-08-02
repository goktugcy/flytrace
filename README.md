# FlyTrace — Flight Intelligence Platform

Real-time flight tracking, event intelligence, and multi-channel notifications.
Modular monolith (Turborepo) on Bun · Hono · PostgreSQL/PostGIS · Redis · Next.js.

> **Design docs:** see [`docs/`](./docs) (00–17). Start with [docs/00-README.md](./docs/00-README.md).

## Requirements

- [Bun](https://bun.sh) ≥ 1.3
- Docker + Docker Compose (for Postgres + Redis)

## Quick start

```bash
# 1. install deps
bun install

# 2. env
cp .env.example .env        # fill in secrets later (OpenSky, VAPID)

# 3. start infra (Postgres+PostGIS, Redis)
bun run infra:up

# 4. database
bun run db:generate         # generate SQL from Drizzle schema (first time / on schema change)
bun run db:migrate          # apply migrations (creates extensions + tables)
bun run db:seed             # seed airlines, airports, providers, settings

# 5. run the API
bun run --cwd apps/api dev  # http://localhost:3001/health
```

## Monorepo layout

```
apps/       api (+ web, admin, tracker, worker, notifier — added in later phases)
packages/   shared (config, logger, errors, events, ids, clock)
            db     (Drizzle schema, migrations, client, seed)
            (providers, ui, notifications, maps — added in later phases)
```

## Scripts (root)

| Script | Purpose |
|--------|---------|
| `bun run dev` | run all apps (turbo) |
| `bun run build` | production build of every app |
| `bun run lint` / `lint:fix` | Biome lint + format |
| `bun run typecheck` | typecheck all packages |
| `bun run test` | run tests |
| `bun run db:generate/migrate/seed/studio` | database workflow |
| `bun run infra:up` / `infra:down` | Docker Compose infra |

## Authentication

Sign-in is a **two-step flow when MFA is enabled** — a correct password produces
a short-lived challenge, never a session:

```
POST /api/auth/sign-in   { email, password }
    → { status: "authenticated", user }   + session & refresh cookies
    → { status: "mfa_required", challengeToken, expiresAt }   (no cookies)

POST /api/auth/mfa/verify { challengeToken, code }   ← TOTP or backup code
    → { status: "authenticated", user }   + session & refresh cookies

POST /api/auth/refresh        rotate the refresh token, mint a new session
POST /api/auth/sign-out       revoke this session + its refresh token
POST /api/auth/sign-out-all   revoke every session and refresh token
```

Account security (all require a session):

```
GET  /api/v1/security/sessions       list your active sessions
GET  /api/v1/security/devices        list your known devices
DELETE /api/v1/security/devices/:id  revoke a device (its sessions AND tokens)
POST /api/v1/security/password       change password → signs you out everywhere
POST /api/v1/security/mfa/setup      begin TOTP enrolment
POST /api/v1/security/mfa/confirm    confirm + receive backup codes
POST /api/v1/security/mfa/disable    disable MFA → signs you out everywhere
```

Properties worth knowing:

- **No raw bearer token is stored.** Sessions, refresh tokens and email/Telegram
  links are persisted as SHA-256 digests only.
- **Refresh tokens rotate** on every use, inside one database transaction.
  Replaying a rotated token past `REFRESH_TOKEN_REUSE_GRACE_MS` (default 10s) is
  treated as a leak: the whole token family, every other refresh token, and
  every session for that user are revoked, audited and notified. Inside the
  grace window it is treated as a double-submit and only rejected.
- **Password change and MFA reset revoke everything**, on purpose.
- Devices are fingerprinted and a first sighting raises an audit event plus a
  notification. Only the **network prefix** of an address is stored by default
  (`SECURITY_IP_STORAGE=prefix|full|none`).

Full detail: [docs/18-production.md §8](./docs/18-production.md).

## Health & metrics

| endpoint | exposure |
|---|---|
| `GET /health` | public — liveness only, probes no dependencies |
| `GET /health/ready` | public — `{ready, checks:{db,redis}}`, 200/503 |
| `GET /health/detailed` | **internal** — needs `INTERNAL_API_TOKEN` |
| `GET /metrics` | **internal** — needs `INTERNAL_API_TOKEN` |

```bash
curl -H "Authorization: Bearer $INTERNAL_API_TOKEN" http://localhost:3001/metrics
```

Outside local development the API **refuses to boot** without
`INTERNAL_API_TOKEN`, rather than leaving those endpoints public. It also
refuses `RATE_LIMIT_BACKEND=memory` and `MFA_CHALLENGE_BACKEND=memory` in
production, where per-process state would silently break across replicas.

## Production

```bash
cp deploy/env/production.env.example .env.production   # fill in every REQUIRED value
docker buildx bake -f deploy/docker-bake.hcl
docker compose -f docker-compose.production.yml --env-file .env.production up -d
```

Migrations run in a **dedicated one-shot job**; no application container
migrates at boot, and every service is gated on that job exiting 0.

See [docs/18-production.md](./docs/18-production.md) for the deployment
reference: rollout plan, backup/restore, connection budget, Redis persistence,
and the reverse-proxy configuration.

## Status

Data source: [OpenSky Network](https://opensky-network.org). Not for operational use.
