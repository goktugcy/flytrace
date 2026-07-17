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
| `bun run lint` / `lint:fix` | Biome lint + format |
| `bun run typecheck` | typecheck all packages |
| `bun run test` | run tests |
| `bun run db:generate/migrate/seed/studio` | database workflow |
| `bun run infra:up` / `infra:down` | Docker Compose infra |

## Status

Phase 0 (foundations) scaffolded: monorepo, shared, full DB schema, API skeleton
(`/health`, `/ready`), Docker Compose, CI. See [docs/17-roadmap.md](./docs/17-roadmap.md).

Data source: [OpenSky Network](https://opensky-network.org). Not for operational use.
