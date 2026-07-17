# 01 — Vision

## 1.1 Problem statement

Flight tracking today is dominated by a handful of consumer apps that are excellent at
raw position display but weak at three things that matter to real users:

1. **Signal over noise.** Users don't want a firehose of ADS-B dots. They want to know
   *the specific flight I care about just took off / is descending / changed gate*, delivered
   where they already are (Telegram, push, email).
2. **Provider-grade status.** Position ≠ status. A plane can be on the ground for reasons
   (de-icing, hold) that only the airline's operational feed explains. Status must be
   **provider-based** and normalized, not scraped ad-hoc.
3. **A product that feels premium.** Most trackers look like utilities. FlyTrace should
   feel like a flagship SaaS: a cinematic 3D landing page, buttery realtime maps, and a
   dashboard that respects the user's attention.

## 1.2 Vision statement

> **FlyTrace is the flight intelligence layer for people who care about a specific
> flight.** It turns raw global aircraft telemetry into *events you can act on*, delivered
> in real time through a beautiful, accessible interface and the channels you already use.

We are not trying to out-source FlightRadar24 on raw coverage. We compete on
**architecture, event intelligence, notification quality, and product experience.**

## 1.3 Product pillars

| Pillar | What it means | How we measure it |
|--------|---------------|-------------------|
| **Realtime** | Sub-second UI reflection of position/status changes | p95 event→client latency |
| **Intelligence** | Derived events, not raw feeds | events derived / positions ingested |
| **Reach** | Notifications where the user already is | delivered / requested, per channel |
| **Craft** | Award-quality UI and interactions | Lighthouse, retention, NPS |
| **Trust** | Correct, explainable, respectful of data sources | false-event rate, provider ToS compliance |

## 1.4 Target users (summarized — full personas in [02-product](./02-product.md))

- **The Waiter** — picking someone up / dropping off; wants takeoff + landing pings.
- **The Frequent Flyer** — tracks their own flights; wants delay/gate/boarding alerts.
- **The Enthusiast** — loves the live map, aircraft types, 3D, deep flight pages.
- **The Operator (Admin)** — internal user monitoring providers, queues, cache, logs.

## 1.5 Non-goals (explicit scope guards)

- **Not** a certified/authoritative source for ATC or dispatch decisions. FlyTrace is
  informational; every surface carries an appropriate disclaimer.
- **Not** a global ADS-B receiver network. We consume OpenSky; we do not run hardware.
- **Not** a data reseller. We do not expose a paid firehose API in the initial phases.
- **Not** microservices on day one. We ship a modular monolith (see [06](./06-backend-architecture.md)).
- **Not** dependent on any single airline scraper. Providers are optional, pluggable,
  degradable; the platform is fully functional on positions alone.

## 1.6 Guiding principles (engineering)

1. **Design for extraction.** Every `apps/*` process could become a service. No shared
   mutable in-process state across module boundaries; communicate via events/queues/DB.
2. **Events are the source of truth for behavior.** If something happens, it is an event.
   UI, notifications, analytics, and audit all derive from the same event stream.
3. **Degrade, don't fail.** No OpenSky? Serve cached tracks. Provider down? Fall back to
   position-derived status. Redis blip? Queue locally and reconcile.
4. **Type safety is not optional.** Zod schemas are the single definition of every external
   contract; types are inferred, never hand-maintained twice.
5. **Cheap to run, cheap to reason about.** Bun + a small fleet of processes over Redis and
   Postgres. Complexity is added only when a metric demands it.
6. **Respect data sources.** Rate limits, caching, backoff, and ToS compliance are
   first-class requirements, not afterthoughts (see [08](./08-providers.md), [15](./15-security.md)).

## 1.7 North-star & supporting metrics

- **North star:** *Actionable events delivered per weekly active user.*
  (A user who receives a correct, timely takeoff/landing/gate event got the core value.)
- **Supporting:**
  - Event correctness rate (derived event confirmed by later data) — target > 98%.
  - p95 position→client latency < 1.5s; p95 event→notification < 10s.
  - Notification delivery success ≥ 99% per channel (excluding user-side opt-outs).
  - Landing-page Lighthouse Performance ≥ 95, Accessibility ≥ 95.
  - WAU→W4 retention of registered users ≥ 35%.

## 1.8 Competitive positioning (architecture lens)

| Capability | FR24-class incumbents | FlyTrace design intent |
|------------|-----------------------|------------------------|
| Position source | Own receiver network | OpenSky (consume) |
| Status source | Proprietary airline feeds | Pluggable provider system |
| Event model | Internal | First-class, typed, replayable event bus |
| Notifications | App push, limited | Telegram + Web Push + Email, extensible |
| Realtime transport | Proprietary | Standard WS, horizontally scalable via Redis |
| Deployability | Large infra | Single Compose stack → extractable services |
| UX | Utility-grade | Flagship SaaS craft |

## 1.9 Success criteria for the *design* (this doc set)

The design is "done" when a competent team could implement each subsystem **without
making an unstated architectural decision**: schemas are specified, contracts are typed,
failure modes are enumerated, scaling paths are drawn, and every table/queue/channel has a
documented reason to exist.
