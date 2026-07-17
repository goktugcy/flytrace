# 02 — Product

## 2.1 Personas

### P1 — "The Waiter" (Deniz) — guest → light registered
- **Context:** Picking up a family member from IST. Checks the app 2–3 times.
- **Jobs:** "Tell me when the plane takes off and when it lands. Don't make me babysit a map."
- **Needs:** Fast flight search by number, a clear timeline, and *two* notifications
  (takeoff, landing) via Telegram or push. Minimal setup friction.
- **Success:** Arrives at the airport at the right time; got a landing ping.

### P2 — "The Frequent Flyer" (Aylin) — registered power user
- **Context:** Flies TK/PC weekly for work. Lives in the dashboard.
- **Jobs:** "Track my flights automatically, warn me about delays, gate changes, boarding."
- **Needs:** Watchlist, favorites (routes, aircraft), rich notification rules, flight history,
  Telegram integration, calendar-friendly ETAs.
- **Success:** Never misses a gate change; trusts the delay alerts.

### P3 — "The Enthusiast" (Mert) — registered explorer
- **Context:** Loves aviation. Browses the live map, aircraft types, airports.
- **Jobs:** "Let me explore. Show me what's flying, on a gorgeous map, with deep detail."
- **Needs:** Beautiful live map, aircraft pages, airport pages, 3D, filters, deep flight pages.
- **Success:** Spends time exploring; saves aircraft/airports; shares links.

### P4 — "The Operator" (internal Admin)
- **Context:** Runs FlyTrace. Needs to know the system is healthy.
- **Jobs:** "Are providers up? Are queues backing up? Is cache healthy? What's erroring?"
- **Needs:** Provider status, queue monitoring, cache monitoring, flight monitoring, logs,
  statistics, audit trail.
- **Success:** Detects and resolves degradation before users notice.

## 2.2 Feature matrix by role

| Feature | Guest | Registered | Admin |
|---------|:----:|:----------:|:----:|
| Flight search | ✓ | ✓ | ✓ |
| Live map | ✓ | ✓ | ✓ |
| Flight page (live) | ✓ | ✓ | ✓ |
| Airport page | ✓ | ✓ | ✓ |
| Aircraft page | ✓ | ✓ | ✓ |
| Watchlist | — | ✓ | ✓ |
| Favorites (routes/aircraft/airports) | — | ✓ | ✓ |
| Notification settings | — | ✓ | ✓ |
| Telegram integration | — | ✓ | ✓ |
| Web Push | — | ✓ | ✓ |
| Email alerts | — | ✓ | ✓ |
| Flight history | — | ✓ | ✓ |
| Dashboard | — | ✓ | ✓ |
| Provider status / queues / cache | — | — | ✓ |
| Logs / statistics / audit | — | — | ✓ |

Guests get full read/explore. Personalization and notifications require an account.

## 2.3 Epics & user stories (with acceptance criteria)

Stories use `As a <role>, I want <capability>, so that <outcome>.`
AC = acceptance criteria.

### Epic A — Discovery & Search
- **A1** As a guest, I want to search a flight by number/route/airport so I can find it fast.
  - AC: Typeahead < 150ms on cached index; supports `TK1980`, `IST→LHR`, `Istanbul`.
  - AC: Zero results returns suggestions + recent searches (if any).
- **A2** As a guest, I want a live global map so I can see what's flying now.
  - AC: Map loads with viewport-bounded aircraft; pan/zoom refetches by bbox; ≤ N markers
    rendered via clustering above a density threshold.

### Epic B — Flight Intelligence
- **B1** As any user, I want a flight page with live position, altitude, speed, ETA, and a
  timeline so I understand the flight at a glance.
  - AC: Values update over WebSocket without reload; timeline reflects derived events.
- **B2** As any user, I want derived events (takeoff/landing/descent) shown on the timeline.
  - AC: Each event has a timestamp, confidence, and source (position-derived vs provider).

### Epic C — Personalization
- **C1** As a registered user, I want to add a flight to my watchlist with per-event notify
  rules so I only get alerts I care about.
  - AC: Choose channels per item; choose event types; see active/expired items.
- **C2** As a registered user, I want favorites for routes, aircraft, and airports.
- **C3** As a registered user, I want a dashboard summarizing tracked flights and recent
  notifications.

### Epic D — Notifications
- **D1** As a registered user, I want to connect Telegram via a deep link so alerts land in
  chat.
  - AC: `/start <token>` links the chat to my account; unlink supported.
- **D2** As a registered user, I want Web Push and Email as alternative/parallel channels.
- **D3** As a registered user, I want per-event, per-channel granularity and quiet hours.

### Epic E — Admin & Operations
- **E1** As an admin, I want a live provider health board (status, latency, error rate).
- **E2** As an admin, I want queue depth, throughput, failure, and DLQ visibility.
- **E3** As an admin, I want cache hit-rate and key-space stats.
- **E4** As an admin, I want searchable logs and an audit trail of sensitive actions.

## 2.4 Notification event taxonomy (product view)

User-subscribable notification triggers (mapped to domain events in [07](./07-event-system.md)):

| User-facing trigger | Derived from | Typical channel |
|---------------------|--------------|-----------------|
| Takeoff | `TakeoffDetected` | push / telegram |
| Landing | `LandingDetected` | push / telegram |
| Arrived (at gate) | provider status + `FlightEnded` | telegram / email |
| Delay | `ProviderUpdated` (sched vs est) | push / telegram / email |
| Cancelled | `ProviderUpdated` (status=cancelled) | all |
| Gate changed | `ProviderUpdated` (gate delta) | push / telegram |
| Entered airspace | geofence on position | telegram |
| Descending | `DescentDetected` (vspeed threshold) | push |

## 2.5 Guest → registered conversion moments

- After a guest sets up a would-be watch → "Create a free account to get notified."
- On a flight page, a "Notify me on takeoff/landing" CTA gates sign-up.
- Post-search of the same flight 2+ times → prompt to save it.

## 2.6 Scope by phase (summary — full plan in [17-roadmap](./17-roadmap.md))

- **MVP (Phase 1):** search, live map, flight page, airport/aircraft pages, positions,
  position-derived events, auth, watchlist, Telegram + Web Push, basic dashboard, admin
  provider/queue view.
- **Phase 2:** Email, richer providers (THY/Pegasus/AJet), gate/delay events, favorites,
  flight history, 3D hero, PWA install, full admin.
- **Phase 3:** More providers (LH/BA), quiet hours, advanced filters, analytics, sharing,
  performance hardening.

## 2.7 Explicit non-features (for now)

- No payments/subscriptions/billing.
- No social graph / following other users.
- No public data API / API keys for third parties.
- No native mobile apps (PWA covers mobile).
- No historical replay/playback of arbitrary past flights beyond retained history windows.

## 2.8 Data & compliance product constraints

- Every provider surface must respect the airline's terms; only **publicly available**
  status is used, cached politely, and attributed. See [08](./08-providers.md) and [15](./15-security.md).
- OpenSky attribution and rate limits are honored; unauthenticated vs authenticated limits
  drive polling cadence (see [08](./08-providers.md) §OpenSky).
- Notifications require explicit opt-in per channel; unsubscribe is always one tap.
