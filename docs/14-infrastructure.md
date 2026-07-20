# 14 — Infrastructure

Docker + Docker Compose for local & single-host prod; Turborepo for the build graph; GitHub
Actions for CI/CD. Designed to lift into Kubernetes when scale demands, without re-architecting
(each `apps/*` is already an independent process/container).

## 14.1 Environments

| Env | Purpose | Data | Deploy |
|-----|---------|------|--------|
| `local` | dev | seeded, fixtures | `docker compose up` + `turbo dev` |
| `preview` | per-PR ephemeral | throwaway | CI spins on PR (optional) |
| `staging` | pre-prod, real OpenSky (auth tier), providers in test mode | prod-like | auto-deploy `main` |
| `production` | live | real | promote from staging (manual approval) |

Config strictly via env vars, validated by the Zod config loader ([06](./06-backend-architecture.md) §6.6);
`.env.example` per app; secrets never in the repo (see [15](./15-security.md)).

## 14.2 Containerization

- **One Dockerfile per app** (multi-stage): `base` (Bun + workspace install with Turborepo
  pruning via `turbo prune --scope=<app>`) → `build` → slim `runtime` (only that app's output +
  prod deps). Small images, fast cold starts (Bun).
- **Non-root** user, read-only FS where possible, `HEALTHCHECK` hitting `/health`.
- **Frontends:** `apps/web`/`apps/admin` built to Next standalone output; served by Node/Bun
  runtime container (or a CDN/edge platform — see §14.7).
- Images tagged `:<git-sha>` (immutable) + `:staging`/`:prod` moving tags; pushed to GHCR.

## 14.3 Docker Compose topology (single-host / local)

```
services:
  postgres     (postgis + timescaledb image)      volume: pgdata
  redis        (persistence AOF for queue instance) volume: redisdata
  api          depends_on: postgres, redis          ports: 3001
  tracker      depends_on: redis, postgres          (leader-locked poller)
  worker       depends_on: redis, postgres          (scale: N)
  notifier     depends_on: redis, postgres
  web          depends_on: api                       ports: 3000
  admin        depends_on: api                       ports: 3002
  # optional:
  tileserver   (self-hosted vector tiles)            (maps)
  migrate      (one-shot: drizzle migrate)           runs before api/worker
  prometheus + grafana + loki  (observability)
  caddy/traefik (reverse proxy, TLS)                 ports: 80/443
```

- **Reverse proxy (Caddy/Traefik):** TLS termination (auto Let's Encrypt), routes `/` → web,
  `/admin` → admin, `/api` + `/ws` → api, security headers, gzip/br, HTTP/2/3.
- **Compose profiles:** `core` (db/redis/api/web), `full` (all apps), `observability`,
  `maps` — start only what you need locally.
- **Scaling on one host:** `docker compose up --scale worker=3 --scale api=2`; proxy load-balances
  api; tracker stays single-active via Redis lock.

## 14.4 Turborepo pipeline

```
turbo.json (conceptual)
  build:      dependsOn ["^build"], outputs [dist, .next]
  typecheck:  dependsOn ["^build"]
  lint / test:  cacheable
  db:migrate / db:seed:  no cache
```
- Remote cache (optional) so CI reuses local build artifacts. `--filter` builds only affected
  apps/packages per PR (change-based).

## 14.5 CI (GitHub Actions)

Pipeline stages (on PR + `main`):
1. **Setup:** checkout, Bun, cache (`~/.bun`, turbo cache).
2. **Affected graph:** `turbo run … --filter=[origin/main]` to limit work.
3. **Quality gates (parallel):** `typecheck`, `lint` (Biome), `format:check`, unit tests
   (`bun test`), **contract tests** (Zod schemas / OpenAPI / event registry — [16](./16-testing.md)).
4. **Integration tests:** spin ephemeral Postgres + Redis (services in the job or testcontainers),
   run migrations, run integration + a smoke of the event pipeline against fixtures.
5. **Frontend:** build web/admin; **bundle-size budgets**; Playwright e2e (headless) against a
   compose stack; **Lighthouse CI** (assert Perf/A11y ≥ 95) on key pages; axe a11y checks.
6. **Security:** dependency audit, secret scan (gitleaks), SAST (CodeQL), Docker image scan
   (Trivy). See [15](./15-security.md).
7. **Build & push images** (on `main`/tags) to GHCR, tagged by SHA.

Branch protection: all gates green + review required to merge to `main`.

## 14.6 CD (deploy)

- **staging:** auto-deploy on merge to `main` — `migrate` job runs Drizzle migrations
  (expand/contract, backward-compatible) → rolling restart of app containers → readiness gate
  (`/ready`) → smoke tests.
- **production:** manual approval promotes the exact staging image SHA. Same migrate→deploy→
  verify flow. **Zero-downtime:** rolling per app; WS nodes drain gracefully (send `reconnect`,
  §[12](./12-websocket.md).8); tracker leader re-elects.
- **Migrations discipline:** expand → deploy code that tolerates both shapes → backfill →
  contract (drop old) in a later release. Never a destructive migration coupled to a deploy.
- **Rollback:** redeploy previous image SHA; migrations are backward-compatible so rollback is
  safe; feature flags (`settings` table) gate risky features for instant off.

## 14.7 Scaling path (monolith → services → k8s)

1. **Vertical + replica scaling** on one host via Compose (`--scale`).
2. **Split Redis** by role (queues vs cache/state) — [09](./09-redis.md) §9.10.
3. **Managed Postgres** (read replica for read-heavy endpoints/analytics; PgBouncer pooling).
4. **Multi-host / k8s:** each app → a Deployment; tracker → StatefulSet/Deployment with leader
   lock; HPA on CPU/queue-depth; WS behind an Ingress with session affinity; the same images.
5. **Service extraction:** because modules already talk via events/queues/HTTP, a hot module
   (e.g. notifier or providers) becomes its own service pointing at shared Redis/DB — no rewrite.
6. **CDN/edge** for `apps/web` static + images; API stays regional near DB/Redis.

## 14.8 Observability stack

- **Logs:** structured JSON → stdout → Loki (or hosted). Correlation-id + trace-id on every line.
- **Metrics:** Prometheus scrape of `/metrics` per app (RED metrics, queue depth, WS conns,
  WS messages/snapshot sizes/reconnects, tracker provider requests/failures/latency,
  observation accept/reject counts, stale/signal-lost/recovered/ended flight counters,
  event latency histograms, provider health, cache hit-rate) → Grafana dashboards (per subsystem:
  API, tracker, queues, providers, WS, notifications).
- **Current tracker metrics limitation:** tracker metrics are registered process-locally; a
  dedicated tracker `/metrics` scrape endpoint is still production wiring.
- **Tracing:** OpenTelemetry across the causal chain (OpenSky poll → event → WS/notification).
- **Alerts:** Alertmanager rules — DLQ depth, ingestion lag, provider circuit open, WS fan-out
  lag, error-rate SLO burn, Postgres/Redis saturation, cert expiry. Route to Slack/Telegram.
- **Uptime/synthetics:** external probe of `/health`, landing page, a canary flight page.
- **Dashboards mirrored in-app** (admin) for operators without Grafana access ([03](./03-ux.md) §3.4.7).

## 14.9 Backups & DR

- **Postgres:** nightly base backup + WAL archiving (PITR); tested restore runbook; retention
  per compliance. Audit/notification tables included.
- **Redis:** treated as rebuildable; queue instance uses AOF so in-flight jobs survive restart;
  cache/state instance loss is tolerable (rebuild from DB + next poll).
- **Object/asset backups** (logos, OG images) if self-hosted.
- **DR target:** RPO ≤ 15 min (WAL), RTO ≤ 1 hr (restore + redeploy images). Runbooks in `infra/`.

## 14.10 Configuration & secrets management

- Env-var driven; secrets from a manager (Docker/Swarm secrets, SOPS-encrypted files, or a KMS/
  Vault) injected at runtime — never baked into images or committed. Rotation runbook.
- Runtime feature flags & operational tunables in the `settings` table (admin-editable) — e.g.
  poll interval, max map markers, provider enablement, notification channel toggles.

## 14.11 External Service Adapters

- **Email:** `EMAIL_PROVIDER=mock|resend|brevo|smtp`. Mock is the default. Resend/Brevo use
  injectable HTTP adapters, SMTP uses an injected transport, and digest sends include stable
  idempotency keys so retry does not intentionally duplicate provider submissions.
- **Flight operations:** `AERODATABOX_API_KEY` enables the `aerodatabox` provider automatically.
  `AERODATABOX_MARKETPLACE=apimarket|rapidapi` selects the auth/header style, and
  `AERODATABOX_BASE_URL` overrides the default marketplace URL. Keep
  `WORKER_PROVIDER_FETCH_SCOPE=watched` on free tiers; `all` intentionally spends provider quota
  for every detected airline flight.
- **Secrets:** `SECRET_PROVIDER=env|infisical|vault`. Remote providers cache values and fall
  back to env when unavailable; missing remote credentials do not break local startup.
- **Tracing:** `OTEL_TRACES_EXPORTER=noop|console|otlp`. OTLP export is best-effort and never
  blocks request handling.
- **Timeseries:** `TIMESERIES_BACKEND=postgres|timescale`; Timescale is optional and only selected
  when the deployment has the extension/hypertables.
- **Backups:** `BACKUP_PROVIDER=mock|pgdump`; pg_dump requires `DATABASE_URL` and `BACKUP_DIR`.
  WAL archive and retention are configured outside the app through `WAL_ARCHIVE_DIR`/backup
  storage policy.

## 14.12 Airspace Dataset Import

- Real OpenAIP, open-flightmaps, or AIXM datasets are opt-in; vendor dataset files are not
  committed. Configure `AIRSPACE_PROVIDER`, `*_DATASET_PATH`, and `AIRSPACE_DATASET_VERSION`.
- OpenAIP can also be imported directly from the Core API by setting
  `AIRSPACE_PROVIDER=openaip`, `OPENAIP_API_KEY`, and either `OPENAIP_COUNTRY` (for example `TR`)
  or `OPENAIP_BBOX`. The key is sent server-side with `x-openaip-api-key`; do not expose it to
  the web app.
- For a global OpenAIP import, set `OPENAIP_GLOBAL_IMPORT=true` and leave `OPENAIP_COUNTRY` /
  `OPENAIP_BBOX` empty. This paginates the full `/airspaces` list, so run it as a scheduled import
  job and avoid app-start imports.
- Admin-triggered global import uses BullMQ queue `airspace.import`: `POST
  /api/v1/admin/airspace/imports/openaip-global` enqueues one worker job, and `GET
  /api/v1/admin/airspace/imports` reports progress. The worker imports page-by-page with
  `OPENAIP_IMPORT_PAGE_DELAY_MS` and retries/backoff on OpenAIP `429 Retry-After`.
- After a successful import, set API/tracker-facing airspace lookup to imported data with
  `AIRSPACE_PROVIDER=db` and `AIRSPACE_DB_SOURCE_PROVIDER=openaip`. Local development can keep
  `AIRSPACE_PROVIDER=mock`.
- Import command: `bun run --cwd packages/db airspace:import`. It loads the provider dataset,
  validates geometry through PostGIS, reports invalid polygons, and upserts by
  `(provider,dataset_version,source_id)`.
- Version rollover policy: set `AIRSPACE_RETIRE_PREVIOUS_VERSIONS=true` to close older versions by
  writing `effective_to`. `AIRSPACE_RETIRE_MISSING=true` also closes records absent from the same
  version, useful for corrected reimports.

## 14.13 Cost & resource posture

- Bun's small footprint + a modular monolith keeps the baseline to ~2 small nodes (app + data).
- Tunables to control cost/load: OpenSky poll cadence, position sampling under backpressure,
  provider fetch cadence by flight phase, WS position update rate, cache TTLs, retention windows.
