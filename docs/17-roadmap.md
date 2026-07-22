# 17 — Roadmap

A phased plan from empty repo to a polished, scalable platform. Each phase is shippable, adds
user-visible value, and hardens the architecture. Sequencing favors de-risking the hardest
technical bets (realtime ingestion + event derivation) early.

## 17.1 Guiding sequencing principles

1. **Prove the spine first.** OpenSky → event derivation → WS → UI is the riskiest path; build a
   thin vertical slice of it before breadth.
2. **Positions before providers.** The platform must be valuable on positions alone; providers
   are enrichment layered on later.
3. **One notification channel end-to-end** before adding channels.
4. **Ship the monolith; keep the seams.** Never add operational complexity a metric hasn't
   demanded.
5. **Quality gates from day one** ([16](./16-testing.md)/[14](./14-infrastructure.md)) — not retrofitted.

## 17.2 Phase 0 — Foundations (Weeks 1–2)

**Goal:** the repo, infra, and contracts everything else stands on.
- Turborepo scaffold; `packages/shared` (config, logger, errors, Zod contract conventions, event
  envelope, clock, ids); base tsconfig, Biome, git hooks.
- `packages/db`: Drizzle setup, extensions migration (postgis/pg_trgm/citext/timescale), core
  catalog tables (airlines/airports/aircraft) + seed.
- Docker Compose (postgres+postgis, redis) + `apps/api` skeleton with `/health` `/ready`.
- CI pipeline (typecheck/lint/unit/contract) + image build; `.env.example`s.
- `packages/ui` bootstrap: tokens, Tailwind config, theme, a few primitives.
- **Exit criteria:** `docker compose up` + `turbo dev` runs; CI green; migrate+seed works.

## 17.3 Phase 1 — Live spine / MVP (Weeks 3–7)

**Goal:** a guest can watch real aircraft move and see derived takeoff/landing; a user can get a
push notification. This is the make-or-break slice.
- `apps/tracker`: OpenSky ingestion (bbox, auth tier, leader lock), normalization, `flight:state`
  in Redis, **position + takeoff/landing/descent detection**, outbox emission.
- `apps/worker`: position persistence (batched), enrichment (resolve fk, link watch matches),
  rollup/retention basics.
- `apps/api`: flight/airport/aircraft/search read endpoints (Redis-hot + DB), **WebSocket
  gateway** (snapshot + deltas, viewport + flight channels, Redis pub/sub fan-out, reconnect
  replay via streams).
- Auth (Better Auth): sign-up/in, sessions, cookies, CSRF.
- Watchlist (create/list/delete) + rule matcher; **notifier** with **Web Push** (one channel
  e2e) — exactly-once delivery.
- `apps/web`: landing (static hero, no 3D yet), global live map (MapLibre, interpolation,
  clustering), flight page (live map + telemetry + timeline), airport/aircraft pages, search,
  auth screens, minimal dashboard.
- Observability baseline (structured logs, `/metrics`, key dashboards); e2e smoke of the live
  spine with the fixture feed; Lighthouse baseline.
- **Exit criteria:** real IST flight tracked live in UI; takeoff/landing events on timeline; a
  watch fires a real web-push; p95 position→client < 2s in staging.

## 17.4 Phase 2 — Enrichment & delight (Weeks 8–13)

**Goal:** provider-grade status, richer notifications, and the premium UI.
- **Provider system** (`packages/providers`): `FlightProvider` + `BaseProvider` (cache, rate
  limit, circuit breaker, logging), registry + discovery; **THY, Pegasus, AJet** providers
  (public status, compliant); `flight_status` projection; `ProviderUpdated` → gate/delay/
  cancelled/arrived events.
- **Telegram** channel (bot, deep-link linking, commands) + **Email** channel (provider,
  DKIM/SPF/DMARC, unsubscribe, verification); per-event/per-channel rules; quiet hours;
  frequency caps.
- Favorites (routes/aircraft/airports); flight history; full dashboard (tracked flights, recent
  notifications feed live, saved items, channel status).
- **3D hero** (React Three Fiber) with reduced-motion + no-WebGL fallbacks; realtime counters;
  feature cards; FAQ; polished landing per [03](./03-ux.md)/[04](./04-design-system.md).
- **PWA**: manifest, service worker, install, offline shell, push via SW.
- **Admin console** (`apps/admin`): provider health, queue monitoring, cache monitoring, live
  flights, logs, stats, audit; DLQ browser with retry.
- Airport pages: live arrivals/departures boards, runways, stats; aircraft pages: history +
  utilization.
- **Exit criteria:** gate-change alert delivered via Telegram; providers visible/healthy in
  admin with circuit-breaker behavior; PWA installable; Lighthouse Perf/A11y ≥ 95 on key pages.

## 17.5 Phase 3 — Scale, breadth & polish (Weeks 14–20)

**Goal:** more coverage, hardened performance, production-grade ops.
- More providers (**Lufthansa, British Airways**) + provider fallback to position-derived status
  proven under outage; provider priority/conflict handling.
- Geofences/airspace events (`EnteredAirspace`), `AircraftChanged`; Open-Meteo weather integration
  now provides cached map hazards and modelled flight-level turbulence potential.
- Realtime scale: sharded position channels, WS multi-node load-tested (k6), backpressure/
  sampling tuning; Redis split (queues vs cache/state); Postgres read replica + PgBouncer;
  Timescale continuous aggregates for history.
- Performance hardening pass: bundle budgets, map/3D optimization, image/OG pipeline, caching
  audit; soak + chaos tests in staging.
- Advanced UX: filters, command palette (⌘K), sharing/OG cards, i18n (EN/TR), quiet-hours &
  digest emails, notification preferences depth.
- Security hardening: MFA for admin, Turnstile on auth, WAF/edge, DAST pass, pen-test, secret
  rotation runbooks, DR restore drill.
- **Exit criteria:** WS holds N-thousand concurrent connections across ≥2 nodes within latency
  SLO; DR restore rehearsed; security review passed; 5 airline providers live.

## 17.6 Phase 4 — Beyond (post-launch, opportunistic)

- Extraction of a hot module (e.g. `notifier` or `providers`) into a standalone service to prove
  the service-ready design; optional k8s deployment.
- Additional channels (SMS/Slack/Discord) via new adapters.
- Analytics/insights surfaces, historical replay within retention, richer aircraft/airport data,
  potential read-only public API (revisiting the [01](./01-vision.md) non-goal) with strict quotas.
- ML-assisted ETA/delay prediction on top of the event history.

## 17.7 Milestones & definition of done

| Milestone | Phase | Definition of done |
|-----------|-------|--------------------|
| M0 Foundations | 0 | CI green, compose up, migrate/seed, health checks |
| M1 Live spine | 1 | live tracking + derived events + push watch e2e in staging |
| M2 Enrichment | 2 | providers + Telegram/Email + 3D landing + PWA + admin |
| M3 Scale & polish | 3 | multi-provider, WS scaled + load-tested, perf/security hardened |
| GA | end 3 | SLOs met, runbooks + DR, docs current, pen-test passed |

## 17.8 Cross-cutting workstreams (continuous)

- **Design system** evolves alongside features (tokens/components as needed).
- **Testing & CI gates** extended with each feature (contracts/e2e/perf).
- **Observability** dashboards/alerts added per subsystem as it lands.
- **Docs** (this set) kept current; ADRs recorded for significant decisions.

## 17.9 Risks & mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|-----------|------------|
| OpenSky rate limits / outages | degraded live data | med | auth tier, bbox scoping, caching, cache-serve on outage, backoff |
| Provider ToS / fragility (HTML changes) | status gaps | med–high | compliance-gated, fixtures + contract tests, circuit breaker, position-derived fallback |
| Realtime scale (WS fan-out) | latency/cost | med | Redis pub/sub + sharded channels, load tests early, multi-node |
| Event correctness (false takeoff/landing) | user trust | med | multi-sample confirmation, confidence scores, golden-file + mutation tests |
| DB write volume (positions) | saturation | med | batching, partition+BRIN, downsampling, backpressure sampling |
| Notification spam / fatigue | churn | low–med | dedupe, quiet hours, frequency caps, granular rules |
| Scope creep on 3D/UX | slipped MVP | med | 3D deferred to Phase 2; MVP ships without it |
| Security incidents | trust/legal | low | defense-in-depth ([15](./15-security.md)), scans in CI, pen-test, least privilege |
| Team/context loss | velocity | low | modular seams, docs + ADRs, high DX, strong tests |

## 17.10 Team & ways of working (suggested)

- Small cross-functional team; trunk-based dev with short-lived branches + PR review; feature
  flags (`settings`) for risky rollouts; weekly staging → gated prod promotion.
- Definition of ready/done enforced via PR template + CI gates; ADRs for architecture decisions;
  on-call runbooks live in `infra/`.
