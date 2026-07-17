# 13 — Frontend

`apps/web` (public + user app) and `apps/admin` (console) are Next.js (App Router) applications
consuming `apps/api` over REST + WebSocket. They share `packages/ui` (design system) and
`packages/shared` (typed contracts). Dark-mode-first, mobile-first, PWA, 95+ Lighthouse.

## 13.1 Framework & rendering strategy

- **Next.js App Router + React Server Components.** Default to **Server Components** for data
  fetching and static/marketing content; **Client Components** only where interactivity/realtime
  is needed (map, 3D, live telemetry, forms).
- **Rendering per route:**
  - Landing: mostly static/SSG + streamed; hero 3D & map hydrated below the fold.
  - Flight/airport/aircraft pages: SSR for first paint + SEO, then client hydration subscribes
    to WebSocket for live updates.
  - `/app/*` and `/admin/*`: authenticated, dynamic (SSR with session), client-heavy.
- **Streaming SSR + Suspense**: page shell + skeletons stream immediately; data-heavy regions
  stream in. No blocking spinner-only screens.

## 13.2 App structure (App Router)

```
apps/web/src/
├─ app/
│  ├─ (marketing)/            landing, faq, legal  — static-leaning
│  │   └─ page.tsx
│  ├─ map/page.tsx            global live map
│  ├─ flights/
│  │   ├─ search/page.tsx
│  │   └─ [callsign]/[date]/page.tsx
│  ├─ airports/[iata]/page.tsx
│  ├─ aircraft/[reg]/page.tsx
│  ├─ (auth)/login|signup/
│  ├─ app/                    authenticated shell (layout w/ rail + guards)
│  │   ├─ dashboard/  watchlist/  favorites/  notifications/  settings/
│  ├─ layout.tsx              root: theme, fonts, providers
│  └─ manifest.ts, sw.ts      PWA
├─ components/                app-specific compositions (use packages/ui primitives)
├─ features/                  feature modules (flight, map, watchlist, auth, notifications)
│   └─ flight/{api,hooks,components,store}
├─ lib/                       api client, ws client, query config, formatters, geo
└─ styles/                    tailwind, tokens bridge
```

- **Feature-folder architecture:** each feature owns its data hooks, components, and local
  store — mirrors backend modularity; easy to reason about and delete.

## 13.3 Data layer

- **Server data:** RSC fetches from `apps/api` using the typed client (`packages/shared`),
  forwarding the session cookie; cached with Next's `fetch` cache + `revalidate` per route.
- **Client data:** **TanStack Query** for client-side reads/mutations (watchlist, favorites,
  settings) — caching, optimistic updates, retry, invalidation.
- **Realtime:** a single **WebSocket client singleton** (see [12](./12-websocket.md)) exposed via a React
  context + hooks (`useFlightLive(flightId)`, `useViewport(bbox)`, `useUserStream()`); it
  merges deltas into a small client store (Zustand) and/or updates Query caches. RSC gives the
  first paint; WS keeps it live.
- **Type safety:** request/response types imported from `packages/shared/contracts` — no
  hand-written client types; a contract mismatch is a compile error.
- **Optimistic UI:** watch add/remove, favorite toggle apply instantly with rollback on error.

## 13.4 Maps (MapLibre GL) — see [04](./04-design-system.md) §4.10

- `packages/maps` holds the style JSON (dark/light), tile config, and geo helpers. `apps/web`
  wraps MapLibre in a `<LiveMap>` client component.
- **Live layers:** GeoJSON source for aircraft updated from the WS store; symbol layer rotated
  by heading, tinted by altitude ramp; flown-track line + projected dashed great-circle;
  clustering above density threshold.
- **Performance:** update sources via `setData` (diff, not re-add); throttle to animation frame;
  **interpolate** positions between updates; cap rendered markers via clustering/viewport
  filtering; use `symbol` layers (GPU) not DOM markers; unmount/cleanup on route change.
- **Interaction:** hover tooltip, click→select+panel, follow mode; keyboard-reachable controls +
  a non-map data-table fallback for a11y ([03](./03-ux.md) §3.7).

## 13.5 3D hero (React Three Fiber)

- Landing hero only. A slowly rotating Earth with animated great-circle arcs and a few moving
  aircraft glyphs — cinematic but cheap.
- **Performance guardrails:**
  - Lazy-loaded + code-split; **not** part of LCP (hero text/CTA are SSR and paint first). The
    canvas mounts after hydration / on idle / when in view.
  - Low-poly sphere, compressed textures (KTX2/basis), instanced arcs, capped DPR
    (`min(devicePixelRatio, 2)`), `frameloop="demand"` where possible.
  - Pauses when tab hidden or off-screen (IntersectionObserver + `visibilitychange`).
  - **`prefers-reduced-motion` → static globe image** (no WebGL), and a no-WebGL fallback image.
  - Hard budget: hero JS ≤ ~150KB gz for the 3D chunk, loaded after interactive.

## 13.6 PWA

- **Installable:** web app manifest (name, icons, theme color, display standalone), maskable
  icons, splash.
- **Service worker** (Workbox or custom): precache app shell + static assets; runtime cache
  strategies — `stale-while-revalidate` for catalog/airport data, `network-first` for live
  endpoints (never cache realtime), `cache-first` for immutable assets.
- **Offline:** cached last-viewed flight/dashboard render read-only with a clear "offline" state;
  WS pauses; queued optimistic mutations retried on reconnect.
- **Web Push** subscription handled in the SW; notification click → focus/open deep link
  (see [10](./10-notifications.md) §Web Push).

## 13.7 Performance (targets & techniques) — see [17](./17-roadmap.md) perf hardening

Targets: **Lighthouse Perf ≥ 95, A11y ≥ 95**, LCP < 2.0s (mobile mid-tier), INP < 200ms,
CLS < 0.05.

Techniques:
- **Code splitting** by route + dynamic `import()` for map, 3D, charts, admin.
- **RSC** keeps heavy libs (maps/3D) out of the server-rendered payload; client bundles minimal.
- **Fonts:** `next/font` (self-hosted, `display=swap`, subset, variable) — no layout shift, no
  external requests.
- **Images:** `next/image` (AVIF/WebP, responsive `sizes`, blur placeholder); reserved
  dimensions to prevent CLS.
- **Skeletons + streaming** for perceived speed; avoid client waterfalls (parallel fetches in RSC).
- **Prefetch** likely next routes (flight card → flight page) via `next/link` prefetch + shared
  query cache seed.
- **Realtime efficiency:** WS deltas (not full payloads), coalesced to frames; virtualization
  (`@tanstack/virtual`) for arrivals/departures/admin tables.
- **Bundle discipline:** size-limit budgets in CI; tree-shakeable UI package; avoid moment/lodash
  bloat (date-fns/temporal, native intl).

## 13.8 State management

- **Server state:** RSC + TanStack Query (source of truth for fetched data).
- **Realtime/ephemeral state:** small **Zustand** stores (live positions, connection status,
  map viewport) — outside React render for high-frequency updates, read via selectors.
- **UI state:** local component state / URL state (filters, tabs in query params for
  shareability + SSR).
- **Auth/session:** from Better Auth client + RSC session; no tokens in JS-accessible storage
  (httpOnly cookie) — see [15](./15-security.md).

## 13.9 Accessibility & theming (implementation)

- Design tokens as CSS vars ([04](./04-design-system.md)); Tailwind maps semantic tokens; theme via
  `data-theme` + no-flash SSR cookie.
- shadcn/ui (Radix) gives accessible primitives (focus management, roles, keyboard nav) for
  dialogs, menus, tabs, combobox.
- Global: skip-link, landmark regions, focus-visible styles, reduced-motion media handling,
  live regions for telemetry/toasts, form error wiring — audited in CI ([16](./16-testing.md)).

## 13.10 Internationalization & formatting

- i18n-ready (next-intl or similar): message catalogs, locale routing optional; initial locales
  EN/TR. All dates/numbers via `Intl` with user prefs (units, 12/24h, tz). Airport-local times
  always labeled with tz.

## 13.11 Admin app

- Same stack; data-dense: virtualized tables, live metric charts (WS `admin:metrics`), DLQ
  browser, provider health cards, log tail with filters. Role-guarded at layout + API.

## 13.12 SEO & sharing

- SSR metadata per page (`generateMetadata`): flight/airport/aircraft pages have descriptive
  titles, Open Graph/Twitter cards (dynamic OG images via `next/og` — e.g. flight route card),
  canonical URLs, structured data where sensible. Marketing pages fully static + fast.
