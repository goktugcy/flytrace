# 04 — Design System

The design system lives in `packages/ui` and is consumed by `apps/web` and `apps/admin`.
It is token-driven (CSS variables), shadcn/ui-based, Tailwind-configured, dark-mode-first.

## 4.1 Token architecture (three layers)

```
Primitive tokens   →   Semantic tokens   →   Component tokens
(raw values)           (roles / intent)      (per-component)
--blue-500: #3B82F6    --color-accent         --button-primary-bg
--space-4: 1rem        --color-bg-elevated    --card-radius
```

Primitives are never used directly in components. Components reference semantic (or their
own component) tokens, so theming = swapping the semantic layer.

## 4.2 Color

### Palette philosophy
Dark-first "night sky / cockpit HUD" aesthetic: deep desaturated navy backgrounds, a cyan/
sky **accent** (aviation, radar), warm amber for caution, red for critical, green for on-time.

### Primitive scale (illustrative)
```
Neutral:  --n-950 #0A0E14  --n-900 #0D1117  --n-800 #161B22  --n-700 #21262D
          --n-600 #30363D  --n-500 #484F58  --n-400 #6E7681  --n-300 #8B949E
          --n-200 #B1BAC4  --n-100 #C9D1D9  --n-50  #F0F6FC
Accent:   --sky-600 #0284C7 --sky-500 #0EA5E9 --sky-400 #38BDF8 --sky-300 #7DD3FC
Success:  --green-500 #22C55E   Warning: --amber-500 #F59E0B
Danger:   --red-500 #EF4444     Info:    --sky-500
Altitude ramp (map): --alt-0 #22C55E → --alt-mid #F59E0B → --alt-high #EF4444 (sequential)
```

### Semantic tokens (dark default → light override)
| Semantic | Dark | Light | Use |
|----------|------|-------|-----|
| `--bg-base` | `#0A0E14` | `#FFFFFF` | app background |
| `--bg-elevated` | `#161B22` | `#F6F8FA` | cards, sheets |
| `--bg-overlay` | `rgba(13,17,23,.72)` | `rgba(255,255,255,.72)` | glass surfaces |
| `--border` | `#21262D` | `#D0D7DE` | dividers, card borders |
| `--fg` | `#F0F6FC` | `#0A0E14` | primary text |
| `--fg-muted` | `#8B949E` | `#57606A` | secondary text |
| `--accent` | `#38BDF8` | `#0284C7` | primary actions, links |
| `--accent-contrast` | `#001018` | `#FFFFFF` | text on accent |
| `--success/warning/danger` | 500s | 600s | status |

**Status semantics (color + icon + label — never color alone):**
`Scheduled`=neutral ●, `EnRoute`=accent ▲, `Landed`=success ■, `Delayed`=warning ◆,
`Cancelled`=danger ✕, `Diverted`=info ↔.

### Contrast & validation
All text/background pairs validated ≥ 4.5:1 (normal) / ≥ 3:1 (large & UI). Accent-on-bg and
status colors are checked in both themes; automated contrast test in CI (see [16](./16-testing.md)).

## 4.3 Typography

- **Display / UI:** `Geist` (or `Inter`) variable font.
- **Numeric / telemetry:** `Geist Mono` / tabular figures (`font-variant-numeric: tabular-nums`)
  so live-updating numbers don't shift width.
- **Type scale (1.250 major-third-ish, rem):**

| Token | Size / line-height | Use |
|-------|--------------------|-----|
| `--text-xs` | 0.75 / 1rem | badges, captions |
| `--text-sm` | 0.875 / 1.25rem | secondary, table cells |
| `--text-base` | 1 / 1.5rem | body |
| `--text-lg` | 1.125 / 1.75rem | lead |
| `--text-xl` | 1.25 / 1.75rem | card titles |
| `--text-2xl` | 1.5 / 2rem | section headers |
| `--text-3xl` | 1.875 / 2.25rem | page titles |
| `--text-5xl` | 3 / 1.1 | hero |
| `--text-7xl` | 4.5 / 1.05 | hero (desktop) |

- Weights: 400 body, 500 UI, 600 headings, 700 hero. Tracking tightened on large sizes.

## 4.4 Spacing & layout

- **Base unit: 4px.** Scale: `0,1,2,3,4,5,6,8,10,12,16,20,24` → `*4px`.
- **Container widths:** content `max-w-7xl` (1280), prose `max-w-2xl`, full-bleed for maps.
- **Grid:** 12-col desktop, 4-col mobile, 24px gutters (16 on mobile).
- **Z-index scale:** base 0, sticky 10, dropdown 20, overlay/sheet 30, modal 40, toast 50,
  tooltip 60.

## 4.5 Radius, elevation, glass

- **Radius:** `--r-sm 6`, `--r-md 10`, `--r-lg 14`, `--r-xl 20`, `--r-full 9999`. Cards `lg`.
- **Elevation (dark uses glow+border more than shadow):**
  `--e-1` subtle border + faint shadow; `--e-2` cards; `--e-3` popovers; `--e-4` modals.
- **Glassmorphism (used sparingly — nav, map panels, hero overlays):**
  `background: var(--bg-overlay); backdrop-filter: blur(16px) saturate(140%); border: 1px solid rgba(255,255,255,.08)`.
  Rule: glass only over busy backgrounds (map, 3D); never for dense text blocks (readability).

## 4.6 Iconography

- **Library:** `lucide-react` (consistent 1.5px stroke). Aviation-specific (plane-takeoff,
  plane-landing, tower-control) from lucide where available; custom SVGs otherwise, same grid.
- Sizes: 16 (inline), 20 (buttons), 24 (nav). Always paired with text or `aria-label`.

## 4.7 Components (specs)

All built on shadcn/ui (Radix primitives) + Tailwind. Each documents variants, sizes, states.

### Button
- Variants: `primary` (accent), `secondary` (elevated), `ghost`, `outline`, `destructive`, `link`.
- Sizes: `sm/md/lg/icon`. States: default/hover/active/focus-visible/disabled/loading.
- Loading shows spinner + preserves width; disabled has `aria-disabled` + not focusable-trap.

### Inputs & forms
- Text, textarea, select, combobox (typeahead search), switch, checkbox, radio, slider,
  segmented control. All with label, hint, error slot, `aria-invalid`/`aria-describedby`.
- Search input = combobox with async results, keyboard nav, empty/error/loading states.

### Cards
- `Card` (base), `StatCard` (label + big tabular number + delta + sparkline), `FlightCard`
  (mini map + status pill + telemetry), `AirportCard`, `AircraftCard`.

### Navigation
- Top bar (glass), left rail (`/app`), bottom tab bar (mobile), breadcrumbs, tabs (Radix),
  command palette (⌘K global search).

### Feedback
- Toast (Sonner-style), inline alert, banner, tooltip, popover, dialog, sheet (mobile),
  confirm dialog (destructive actions).

### Data display
- Table (sortable, virtualized for arrivals/departures/admin), badge/pill, timeline,
  key-value list, avatar, progress, meter.

### Overlays
- Map side panel, flight detail sheet, filter drawer.

## 4.8 Motion (Motion / `motion` library)

- **Principles:** motion clarifies causality and continuity; it is never decorative-only on
  data. All motion respects `prefers-reduced-motion`.
- **Durations:** micro 120ms, standard 200ms, entrance 320ms, hero/ambient 600ms+.
- **Easing:** `--ease-standard` cubic-bezier(0.2,0,0,1); `--ease-emphasized` (0.2,0,0,1) w/
  longer duration; springs for draggable/interactive.
- **Patterns:**
  - Value updates: number tween (250ms) + subtle flash on change.
  - Map aircraft: **position interpolation** between server updates (lerp heading + coords)
    so planes glide, not teleport.
  - List entrance: staggered fade-up (30ms stagger, cap total).
  - Route transitions: shared-element for flight card → flight page header.
  - Skeleton shimmer: 1.2s linear loop, disabled under reduced-motion (static).
- **Performance:** animate only `transform`/`opacity`; avoid layout-triggering props.

## 4.9 Charts / data viz

- **Library:** Recharts (or visx) themed via tokens. See project `dataviz` conventions.
- **Types used:** sparkline (utilization, movements), line/area (stats over time), bar
  (top routes), gauge/meter (on-time %), altitude profile (area) on flight page.
- **Rules:** categorical series use a fixed accessible sequence; sequential ramp for
  altitude; always axis labels + accessible `<title>/<desc>`; tooltips keyboard-reachable;
  never color-only encoding (add markers/patterns).

## 4.10 Map styles (MapLibre GL) — see [13](./13-frontend.md) for integration

- **Dark base style** ("FlyTrace Night"): muted land `#0D1117`, water `#0A0E14`, subtle
  labels `#8B949E`, minimal POI, boosted contrast for coastlines and country borders.
- **Light style** ("FlyTrace Day") as override.
- **Layers (custom):** aircraft symbol layer (rotated icon by heading, sized by zoom),
  flown-track line, projected-track dashed line, airport symbols, runway lines, cluster
  circles + count labels, geofence/airspace fill (low opacity).
- **Aircraft icon:** single SVG, tinted by altitude ramp; on-ground uses distinct muted tint.
- **Interaction:** hover tooltip, click → select (highlight + panel), follow mode recenters.
- Tiles: self-hostable vector tiles or a provider; style JSON lives in `packages/maps`.

## 4.11 Theming & implementation notes

- Tokens shipped as CSS variables on `:root` (dark) + `[data-theme="light"]`.
- Tailwind config maps semantic tokens to utility classes (`bg-base`, `text-muted`, `border`).
- Theme toggle persists (localStorage + cookie for SSR no-flash); respects `prefers-color-scheme`
  on first visit.
- Design tokens are the single source; Figma variables mirror the same names.

## 4.12 States catalog (cross-component)

Every interactive surface must define: default, hover, focus-visible, active, disabled,
loading, error, empty, success. Skeleton + empty + error are mandatory for any async region
(enforced in review, see [16](./16-testing.md)).
