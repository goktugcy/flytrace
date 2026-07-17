# 10 — Notifications

The notification system turns **flight events** into **messages delivered to the channels the
user chose**. It lives in `apps/notifier` + `packages/notifications`, is fully event-driven,
extensible to new channels, and exactly-once per (user, event, channel).

## 10.1 Supported channels (v1) and extensibility

| Channel | Transport | Verification | Notes |
|---------|-----------|--------------|-------|
| **Telegram** | Bot API | deep-link `/start <token>` | richest UX, buttons, instant |
| **Web Push** | VAPID / Push API | browser permission + subscription | works via PWA/service worker |
| **Email** | SMTP / provider (Resend/SES) | verified address | fallback, digests |

**Extensibility:** each channel is a `NotificationChannel` adapter implementing a common
interface; adding SMS/Slack/Discord later = a new adapter + a `channel` enum value + a template
set. Core never branches on channel type beyond the registry lookup.

```
interface NotificationChannel {
  readonly key: "telegram" | "webpush" | "email";
  verifyAddress(input): Promise<VerifyResult>;
  send(msg: RenderedMessage, address: ChannelAddress): Promise<DeliveryResult>;
  capabilities: { buttons: boolean; richText: boolean; images: boolean; maxLength: number };
}
```

## 10.2 Subscription model

Users subscribe via **watchlist items** ([05](./05-database.md) `watchlist_items`): each item ties a
flight (or matcher) to a set of **event types** and a set of **channels**. Plus:

- **`notification_channels`** — the user's connected endpoints (telegram chat, push
  subscription, email), each with `verified`/`enabled` state.
- **`user_settings.quiet_hours`** — a time window (with tz) during which non-critical alerts are
  suppressed or deferred.
- **Per-item overrides** > **user defaults** > **channel enabled** — resolution order.

### Subscribable triggers (product → event mapping)
| User trigger | Source event ([07](./07-event-system.md)) | Critical? (bypasses quiet hours) |
|--------------|-------------------------------------------|----------------------------------|
| Takeoff | `TakeoffDetected` | no |
| Landing | `LandingDetected` | no |
| Descending | `DescentDetected` | no |
| Entered airspace | `EnteredAirspace` | no |
| Arrived (gate) | `ArrivedAtGate` / `FlightEnded` | no |
| Delay | `DelayDetected` | **yes** (time-sensitive) |
| Gate changed | `GateChanged` | **yes** |
| Cancelled | `FlightCancelled` | **yes** |

## 10.3 Delivery pipeline (event → message)

```
domain event (e.g. GateChanged)  ──▶ notifier: RULE MATCHER
  1. find active watchlist_items matching flightId + event type
  2. for each item → for each channel:
       - check channel enabled + verified
       - check quiet hours (skip/defer unless critical)
       - build dedupeKey = userId:flightEventId:channel
       - emit NotificationRequested (BullMQ notify.send, one job/channel)
  3. DELIVERY WORKER (per channel):
       - idempotency guard (idem:<dedupeKey>) + unique(notifications.dedupe_key)
       - render template (channel-specific) with flight/event context
       - adapter.send() with timeout + retry/backoff
       - persist notifications row (queued→sent/failed)
       - emit NotificationSent / NotificationFailed → WS dashboard feed
```

- **Fan-out control:** one BullMQ job per (user,event,channel) keeps retries isolated — a
  Telegram outage doesn't block email.
- **Batching/coalescing:** rapid successive changes (e.g. gate A→B→C within seconds) are
  debounced per (flight,type) so users get one "gate is now C", not three.

## 10.4 Templating

- **Engine:** a small typed template registry in `packages/notifications/templates`. Each
  (eventType × channel) maps to a template function `(ctx) => RenderedMessage`.
- **Context (`ctx`):** normalized, channel-agnostic: `{ flightNumber, airline, route{from,to},
  status, event{type,at,payload}, deepLink, aircraft?, gate?, delayMinutes? }`.
- **Rendered output per channel:**
  - Telegram: Markdown/HTML + inline buttons ("Open flight", "Mute", "Stop watching").
  - Web Push: `{ title, body, icon, badge, url, actions[] }`.
  - Email: MJML/HTML + plaintext fallback, unsubscribe footer, preheader.
- **Localization:** templates keyed by locale (`user_settings.locale`); units per user prefs
  (km/mi/nm, 12/24h). Time always shown with the relevant airport-local tz.
- **Copy tone:** per [03](./03-ux.md) §3.9 — "Wheels up. TK1980 IST→LHR departed 14:32."

### Example rendered messages (illustrative)
- **Takeoff (Telegram):** `✈️ *Wheels up* — TK1980 (IST → LHR) departed at 14:32 local.`
  buttons: `[Open] [Stop watching]`
- **Gate change (Push):** title `Gate changed — TK1980`, body `Now boarding at B7 (was A12).`
- **Delay (Email):** subject `TK1980 delayed ~40 min`, body with new ETA, reason if provided.

## 10.5 Reliability & idempotency

- **Exactly-once per (user,event,channel):** enforced by `unique(notifications.dedupe_key)` +
  a pre-send `idem:` Redis guard. A retried job that already sent is a no-op.
- **Retries:** 5× exponential + jitter (5s→10m); on exhaustion → `notify.dlq`, `notifications`
  row marked `failed` with reason, surfaced in dashboard + admin.
- **Provider outages:** per-channel circuit awareness; if Telegram Bot API 429s, respect
  `retry_after`; email provider bounce/complaint handling disables the address (`verified=false`)
  and notifies the user in-app.
- **Ordering:** notifications for a flight processed per `flightId` partition to avoid
  out-of-order "landed" before "descending".

## 10.6 Channel specifics

### Telegram
- Single bot (`FlyTraceBot`). **Linking:** app mints a one-time `link_token` →
  `t.me/FlyTraceBot?start=<token>`; on `/start <token>` the notifier resolves token → stores
  `chat_id` in `notification_channels`, marks verified, sends a welcome + test button.
- **Commands:** `/start`, `/stop` (disable), `/status <flightNo>` (on-demand), `/mute <id>`.
- **Inbound webhook** handled by `apps/api` (or notifier) → validates Telegram secret token.
- Unlink from settings revokes `chat_id`.

### Web Push
- **VAPID** keys (server) + service worker (PWA) subscription. Subscription `{endpoint, keys}`
  stored in `notification_channels`. Permission requested contextually (not on load).
- Handle `410 Gone`/`404` → prune dead subscription. Payloads encrypted (Web Push protocol).
- Notification click → focus/opens deep link to flight page (handled in service worker).

### Email
- Provider abstraction (Resend/SES/SMTP) behind the adapter. **DKIM/SPF/DMARC** configured
  (see [15](./15-security.md)). Double opt-in for the address. One-click **unsubscribe** (RFC 8058
  `List-Unsubscribe`) + per-type email preferences. Bounce/complaint webhooks → suppress list.
- Used for less time-critical alerts and optional **daily/route digests** (batched job).

## 10.7 Quiet hours & preferences

- `quiet_hours = { tz, start:"22:00", end:"07:00" }`. Non-critical events during the window are
  **deferred** to window end (coalesced) or dropped per user choice; **critical** events
  (delay/gate/cancelled) always deliver.
- Global mute, per-item mute, and per-channel enable/disable. Frequency cap per flight to
  prevent alert fatigue (config, e.g. ≤ N/flight/hour except critical).

## 10.8 Privacy, consent, compliance

- Every channel requires explicit opt-in; every message includes a way to stop
  (Telegram button/command, push settings, email unsubscribe).
- No notification content beyond what the user is entitled to see; deep links require auth.
- PII (email, chat id) encrypted at rest where feasible, redacted in logs.
- Delivery records retained per [05](./05-database.md) §5.12; user can clear history + delete channels.

## 10.9 Observability

- Metrics: requested/sent/delivered/failed/suppressed per channel + per event type; delivery
  latency (event→sent) histogram; DLQ depth; bounce/complaint rates.
- Every notification carries `correlationId` back to the originating event/position for tracing.
- Admin sees per-channel health and can replay DLQ items.
