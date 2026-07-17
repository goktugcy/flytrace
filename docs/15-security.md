# 15 — Security

Security is designed in, not bolted on: defense in depth across authentication, authorization,
transport, input validation, rate limiting, secrets, and abuse prevention. Threat model spans
untrusted clients, abusive bots, and third-party data sources.

## 15.1 Authentication (Better Auth)

- **Better Auth** owns identity: email+password (Argon2id/bcrypt hashing, never home-rolled),
  OAuth (Google/GitHub/Apple as configured), email verification, password reset, session mgmt.
- **Sessions:** server-side sessions (`sessions` table) referenced by a **cookie**:
  `httpOnly`, `Secure`, `SameSite=Lax`, `__Host-` prefix, short-ish TTL + sliding renewal,
  rotation on privilege change. No JWT in `localStorage` (XSS-exfiltration risk).
- **WS auth:** short-lived single-use signed **WS ticket** minted from the session
  (see [12](./12-websocket.md) §12.7) — cookies aren't reliable for cross-origin WS.
- **MFA-ready:** TOTP support enabled for admin accounts (Better Auth plugin) — required for
  `role=admin`.
- **Account security:** login rate limiting + lockout/backoff, breach-password check (k-anon
  HIBP), device/session list with revoke, notification on new-device login.

## 15.2 Authorization

- **RBAC:** `user` vs `admin` roles (`users.role`). Admin API guarded by `requireRole('admin')`
  middleware; admin UI guarded at layout + server.
- **Ownership checks:** every user-scoped resource (watchlist, favorites, channels, notifications)
  verified `resource.userId === session.userId` in the service layer — never trust an id from the
  client. Object-level authorization on every mutation and read.
- **Least privilege:** the API's DB role has only needed grants; no `SUPERUSER`; migrations run
  with a separate role.
- **Fail closed:** unknown/unauthenticated → deny; default route guard requires auth except an
  explicit public allowlist.

## 15.3 Transport & headers

- **TLS everywhere** (proxy termination, HSTS with preload). HTTP→HTTPS redirect.
- **Security headers** (via proxy + Hono middleware): `Content-Security-Policy` (strict:
  self + explicit map/tile/CDN origins, `frame-ancestors 'none'`, no inline scripts — nonce/hash
  based), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy` (disable unused features), `X-Frame-Options: DENY`, COOP/COEP/CORP as
  compatible with maps/3D.
- **CORS:** strict allowlist of known frontend origins; credentials only for those; no `*` with
  credentials.

## 15.4 CSRF

- Cookie-based auth → CSRF protection: `SameSite=Lax` cookies + **double-submit / synchronizer
  token** (Better Auth CSRF) for state-changing requests; verify `Origin`/`Referer` on unsafe
  methods. GET endpoints are side-effect-free. WS handshake uses the signed ticket (not cookies)
  so it's not CSRF-forgeable.

## 15.5 XSS

- **React auto-escaping**; **no `dangerouslySetInnerHTML`** except vetted, sanitized content
  (DOMPurify) — provider data is treated as untrusted and rendered as text.
- Strict **CSP** (nonce-based, no `unsafe-inline`) as a second line of defense.
- User-generated/free-text fields (names, search) escaped + length-limited; email/telegram
  templates escape interpolated values.

## 15.6 SQL injection

- **Drizzle ORM** with parameterized queries exclusively; raw SQL only via `sql` template with
  bound params, never string concatenation of user input.
- Input validated/typed by Zod before it reaches queries; identifiers (sort/filter fields)
  chosen from **whitelists**, never passed through.
- DB user least-privilege; row counts/limits enforced to prevent resource-exhaustion queries.

## 15.7 Input validation

- **Zod at every boundary:** HTTP params/query/body, WS messages, queue job payloads, provider
  responses, webhook bodies (Telegram/email). Reject on mismatch (`422` / drop to malformed DLQ).
- Size/format limits: body size cap, string lengths, array bounds, numeric ranges (bbox, dates),
  content-type checks. Reject unexpected fields (strict schemas where appropriate).

## 15.8 Rate limiting & abuse

- **Redis-backed** sliding-window/token-bucket (Lua-atomic) at multiple scopes: per IP (global +
  per sensitive route), per user, per session, per WS connection. Tiered limits (anon < user <
  admin). Returns `429` + `Retry-After` + `X-RateLimit-*` ([11](./11-api.md) §11.8, [09](./09-redis.md) §9.9).
- **Auth endpoints** get strict throttling + exponential lockout to resist credential stuffing.
- **WS:** connection caps per IP/user, subscription caps, message-rate caps.
- **Search/live endpoints:** stricter buckets (they're cheap to abuse, costly to serve).

## 15.9 Bot protection

- **CAPTCHA (Cloudflare Turnstile)** on sign-up, password reset, and abnormal login patterns —
  privacy-friendly, low-friction. (Skill `turnstile-spin` available.)
- Edge/WAF (Cloudflare) for DDoS/L7 mitigation, bot scoring, IP reputation; block/challenge
  abusive traffic before it reaches origin.
- Honeypot fields + timing heuristics on public forms; progressive friction for suspicious IPs.
- Public API responses avoid enabling scraping-as-a-service (rate limits, no bulk firehose,
  per-[01](./01-vision.md) non-goals).

## 15.10 Secrets & configuration

- Secrets via a manager (Vault/KMS/SOPS/Docker secrets), injected at runtime; **never** in the
  repo, images, logs, or client bundles. `.env.example` documents names only.
- Zod config loader fails fast if a required secret is missing; secrets redacted in logs.
- **Rotation:** documented rotation for DB creds, Redis auth, OpenSky OAuth, VAPID keys, Telegram
  bot token, email provider keys, session signing keys, WS ticket signing key.
- Client env: only `NEXT_PUBLIC_*` non-secret values reach the browser (enforced by convention +
  build check).

## 15.11 Provider & third-party protection

- **Outbound isolation:** provider calls have strict timeouts, circuit breakers, per-provider
  rate budgets, and run in `apps/worker` — a hostile/malformed upstream can't take down core
  (see [08](./08-providers.md)).
- **Untrusted upstream data:** provider/OpenSky responses Zod-validated + sanitized before
  storage/render; never `eval`'d; HTML parsing sandboxed.
- **SSRF guard:** provider base URLs are from vetted config only (no user-supplied URLs);
  outbound requests restricted to known hosts.
- **Webhooks in:** Telegram webhook validated via secret token; email provider webhooks
  signature-verified; replay-protected.
- **Compliance:** only publicly available data, per each source's ToS; polite rate limits;
  attribution ([08](./08-providers.md) §8.9, [01](./01-vision.md) non-goals).

## 15.12 Data protection & privacy

- **Encryption in transit** (TLS) and **at rest** (DB volume + backups encrypted; sensitive
  columns — email, telegram chat id, push keys — app-level encrypted where feasible).
- **PII minimization:** collect only what's needed; redact PII in logs; access to PII gated +
  audited.
- **User rights:** export my data, delete account (cascade personalization + suppress
  notifications), clear notification history, disconnect channels — per [10](./10-notifications.md) §10.8.
- **Audit trail** (`audit_logs`, append-only) for admin actions, auth events, sensitive changes
  ([05](./05-database.md) §5.8).
- **Retention** windows enforced by jobs ([05](./05-database.md) §5.12); logs scrubbed of secrets.

## 15.13 Application hardening

- Dependencies pinned + audited (Dependabot/Renovate), CI blocks known-critical CVEs.
- SAST (CodeQL), secret scanning (gitleaks), container scanning (Trivy) in CI ([14](./14-infrastructure.md)).
- Error responses never leak stacks/SQL/internal ids (typed `AppError` → safe envelope).
- Idempotency + replay protection on mutations and webhooks.
- Principle of least privilege for all service credentials; network segmentation (DB/Redis not
  publicly reachable; only app subnet).

## 15.14 Threat model summary (STRIDE-ish)

| Threat | Vector | Mitigation |
|--------|--------|------------|
| Spoofing | stolen cookie/ticket | httpOnly/Secure cookies, short-lived single-use WS tickets, MFA (admin) |
| Tampering | modified request/id | Zod validation, ownership checks, signed tickets |
| Repudiation | disputed admin action | append-only audit log w/ actor+ip+correlationId |
| Info disclosure | scraping, IDOR, leaks | rate limits, object-level authz, safe errors, CSP |
| DoS | flood, expensive queries | WAF/edge, rate limits, query limits, backpressure/sampling |
| Elevation | role bypass | RBAC guards, fail-closed defaults, least-privilege DB roles |
