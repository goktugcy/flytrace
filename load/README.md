# FlyTrace Load Testing (k6)

Load and soak tests for the FlyTrace read path and WebSocket gateway, written
for [k6](https://k6.io). k6 is a standalone CLI (a single Go binary) — it is
**not** an npm dependency and nothing here is wired into the monorepo build.

```
load/
├── config.js                  shared endpoints, viewports, stage presets, WS ticket helper
├── scenarios/
│   ├── api-burst.js           HTTP burst → /flights/live + /stats/live
│   ├── ws-connections.js      concurrent WS connection storm (up to 50k)
│   └── aircraft-stream.js     position-stream cadence assertions
├── run.sh                     runs a scenario+profile, writes results/<run>.json
├── report.js                  consolidates results/*.json → markdown
└── results/                   summary JSON exports (gitignored)
```

## Install k6

k6 is a separate CLI. Pick one:

```sh
# macOS
brew install k6

# Debian/Ubuntu
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6

# Windows
choco install k6            # or: winget install k6

# Docker (no local install)
docker run --rm -i grafana/k6 run - <load/scenarios/api-burst.js
```

Verify: `k6 version`.

## Configuration (env vars)

| Var        | Default                     | Meaning                                   |
|------------|-----------------------------|-------------------------------------------|
| `BASE_URL` | `http://localhost:3001`     | HTTP base for the API                     |
| `WS_URL`   | derived from `BASE_URL`     | WebSocket base (`ws://…`)                 |
| `VUS`      | per-profile preset          | override concurrent VUs (WS scenarios)    |
| `PROFILE`  | `smoke`                     | stage preset: `smoke`/`1k`/`5k`/`10k`/`50k-ws` |

The API must be running first (from repo root: `bun run dev`, API defaults to
`:3001`). The read path serves from Redis hot-state and the WS gateway requires
a signed ticket — the scripts mint one per connection automatically via
`POST /api/v1/ws/ticket`, so no auth setup is needed for public channels.

## Run

Via the runner (writes a summary JSON to `results/`):

```sh
load/run.sh api-burst 1k
load/run.sh api-burst 5k
load/run.sh api-burst 10k
VUS=50000 load/run.sh ws-connections 50k-ws
load/run.sh aircraft-stream smoke

# against a LAN / staging host
BASE_URL=http://api.local:3001 load/run.sh api-burst 10k
```

Or call k6 directly:

```sh
k6 run -e PROFILE=1k load/scenarios/api-burst.js
k6 run -e VUS=1000 load/scenarios/ws-connections.js
k6 run -e VUS=200 load/scenarios/aircraft-stream.js
```

### Profiles

| Profile  | api-burst target VUs | ws target connections |
|----------|----------------------|-----------------------|
| `smoke`  | 5                    | 10                    |
| `1k`     | 1,000                | 1,000                 |
| `5k`     | 5,000                | 5,000                 |
| `10k`    | 10,000               | 10,000                |
| `50k-ws` | —                    | 50,000                |

HTTP presets ramp virtual users through stages; WS presets hold a steady pool of
open connections (`ramp → hold → drain`). Targets are starting points — tune the
stage arrays in `config.js` to what your load generator and target box sustain.

> **50k connections:** a single k6 process and the OS need headroom. Raise file
> descriptor limits (`ulimit -n 1048576`), consider `net.ipv4.ip_local_port_range`
> and ephemeral port exhaustion (use multiple target hosts/IPs), and run k6 on a
> machine separate from the API. For very large runs, shard across several k6
> processes each with a slice of `VUS`.

## Report

After one or more runs:

```sh
node load/report.js
node load/report.js --out load/results/REPORT.md      # also write markdown to a file
node load/report.js load/results/api-burst-1k-*.json  # specific runs
```

The report prints a per-run table (requests, RPS, p95/avg/max latency, error
rate, checks) plus a WebSocket roll-up (connect p95, time-to-hello, connect
success, message counts, stream cadence) and an SLO pass/fail summary.

## SLOs (thresholds)

Enforced by k6 (`options.thresholds`); a breach makes `k6 run` exit non-zero:

- **`http_req_duration` p95 < 500 ms**
- **`http_req_failed` rate < 1%**
- **checks pass rate > 99%** (HTTP), **> 95%** (stream)
- **ws connect success > 95%**, connect p95 < 1 s, time-to-hello p95 < 1.5 s
- **stream inter-message gap p95 < 30 s** (cadence guard)

## What each scenario exercises

- **api-burst** — the map-bootstrap read path: `GET /flights/live?bbox=…`
  (viewport-clipped Redis hot-state) and `GET /stats/live` (landing counters).
  Ramps to high RPS and asserts the latency/error SLOs.
- **ws-connections** — connection scale. Each VU mints a ticket, upgrades `/ws`,
  sends a `viewport` message, heartbeats with `ping`, and holds. Measures
  connect time, time-to-`hello`, and inbound message rate. Scale with `VUS`.
- **aircraft-stream** — a smaller pool that *consumes* the position stream and
  asserts the server keeps pushing frames at a healthy cadence (inter-message
  gap), catching stalls rather than raw connection count.
