# FlyTrace — Flight Intelligence Platform

> Design documentation set. **Design-only — no implementation code.**
> Target: a production-grade, event-driven, modular-monolith flight tracking platform
> architecturally comparable to FlightRadar24 (architecture, not data-source parity).

---

## What this is

FlyTrace is a real-time **Flight Intelligence Platform**. It ingests live aircraft
positions from the OpenSky Network, enriches them with airline-specific flight status
from a pluggable **provider system**, derives high-level flight events (takeoff, landing,
descent, gate change), streams everything to clients over WebSocket, and delivers
multi-channel notifications (Telegram / Web Push / Email).

The system is built as a **modular monolith** (`Turborepo`) that is deliberately designed
so any module can later be extracted into an independent service without rewrites.

## How to read this documentation

Read in order for a top-down understanding, or jump directly to a subsystem.

| # | Document | Audience | Purpose |
|---|----------|----------|---------|
| 01 | [Vision](./01-vision.md) | All | Why the product exists, principles, north-star metrics |
| 02 | [Product](./02-product.md) | PM / Eng | Personas, features, user stories, scope, non-goals |
| 03 | [UX](./03-ux.md) | Design / FE | Information architecture, flows, page specs, a11y |
| 04 | [Design System](./04-design-system.md) | Design / FE | Tokens, components, motion, map styles |
| 05 | [Database](./05-database.md) | BE / Data | Full PostgreSQL + PostGIS schema, indexes, rationale |
| 06 | [Backend Architecture](./06-backend-architecture.md) | BE | Monorepo layout, apps, DI, module boundaries |
| 07 | [Event System](./07-event-system.md) | BE | Event catalog, envelope, producers/consumers, retries |
| 08 | [Providers](./08-providers.md) | BE | Provider interface, DI, discovery, health, THY/Pegasus/… |
| 09 | [Redis](./09-redis.md) | BE / Infra | Every Redis usage: cache, pub/sub, bus, locks, rate limit |
| 10 | [Notifications](./10-notifications.md) | BE | Channels, subscription model, templating, delivery |
| 11 | [API](./11-api.md) | BE / FE | REST surface, contracts, pagination, errors, versioning |
| 12 | [WebSocket](./12-websocket.md) | BE / FE | Realtime protocol, channels, reconnect, horizontal scale |
| 13 | [Frontend](./13-frontend.md) | FE | Next.js app structure, data layer, map, 3D, PWA, perf |
| 14 | [Infrastructure](./14-infrastructure.md) | DevOps | Docker, Compose, CI/CD, environments, observability |
| 15 | [Security](./15-security.md) | All | AuthN/Z, rate limiting, CSRF/XSS/SQLi, secrets, bots |
| 16 | [Testing](./16-testing.md) | All | Test pyramid, tooling, contract tests, load tests |
| 17 | [Roadmap](./17-roadmap.md) | All | Phased delivery plan, milestones, risks |

## Architecture at a glance

```
                        ┌─────────────────────────────────────────────┐
                        │                  clients                      │
                        │  web (Next.js PWA)   admin   Telegram   push  │
                        └───────▲───────────────▲──────────▲───────────┘
                                │ REST/WS        │          │
                        ┌───────┴────────────────┴──────────┴───────────┐
                        │                  apps/api (Hono)               │
                        │   REST · WebSocket gateway · auth · admin API  │
                        └───────▲───────────────▲──────────▲────────────┘
                                │ pub/sub        │ enqueue  │ query
             ┌──────────────────┴──┐   ┌─────────┴────┐   ┌─┴──────────────┐
             │   apps/tracker      │   │  apps/worker │   │  apps/notifier │
             │ OpenSky poll →      │   │ BullMQ jobs: │   │ consumes        │
             │ state diff →        │   │ enrich,      │   │ Notification*   │
             │ event derivation    │   │ provider,    │   │ events →        │
             │                     │   │ persistence  │   │ TG/Push/Email   │
             └─────────┬───────────┘   └──────┬───────┘   └────────┬───────┘
                       │                       │                    │
             ┌─────────▼───────────────────────▼────────────────────▼───────┐
             │      Redis  (cache · pub/sub · event bus · BullMQ · locks)    │
             └─────────┬─────────────────────────────────────────────┬──────┘
                       │                                               │
             ┌─────────▼──────────┐                        ┌──────────▼──────┐
             │ PostgreSQL+PostGIS │                        │ packages/*      │
             │ durable state      │                        │ providers, db,  │
             │ (flights, events)  │                        │ shared, ui, ... │
             └────────────────────┘                        └─────────────────┘
```

## Core design principles

1. **Event-driven everywhere.** State changes emit typed domain events; side effects are consumers.
2. **Modular monolith, service-ready.** Clear module seams, no cross-module DB reads, contracts over imports.
3. **Providers are plugins.** The core never imports a concrete airline provider.
4. **Realtime is a first-class product surface**, not a bolt-on.
5. **Type-safe end to end.** Zod at every boundary; Drizzle-typed DB; shared contract package.
6. **Dark-mode-first, mobile-first, accessible, fast** (95+ Lighthouse).
7. **Operable.** Every subsystem is observable, rate-limited, and gracefully degrading.

## Glossary (used across all docs)

- **Position** — a raw `(lat, lon, alt, heading, velocity, ts)` sample for an aircraft.
- **Track** — an ordered series of positions for one flight leg.
- **Flight (leg)** — a single scheduled origin→destination movement (`TK1980, 2026-07-17`).
- **Flight State** — the live, in-memory/Redis representation of a flight leg.
- **Flight Event** — a derived domain fact (`TakeoffDetected`, `LandingDetected`).
- **Provider** — a plugin that returns normalized status for an airline's flights.
- **Watchlist item** — a user's subscription to a flight/route/aircraft with notify rules.
