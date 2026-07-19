// Shared configuration and helpers for FlyTrace k6 load scenarios.
//
// Everything is driven by environment variables so the same scripts run against
// local dev, a LAN host, or a staging deploy without edits:
//
//   BASE_URL  HTTP base for the API           (default http://localhost:3001)
//   WS_URL    WebSocket base for the gateway   (default derived from BASE_URL)
//   VUS       virtual users / concurrent conns (per-scenario default applies)
//   PROFILE   one of: smoke | 1k | 5k | 10k | 50k-ws  (selects a stage preset)
//
// k6 has no package resolution; every scenario `import`s from this file.

import http from 'k6/http';
import { check } from 'k6';

// ── Endpoints ────────────────────────────────────────────────────────────────

export const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3001').replace(/\/$/, '');

// Derive the ws:// base from BASE_URL unless WS_URL is given explicitly.
export const WS_URL = (
  __ENV.WS_URL || BASE_URL.replace(/^http(s?):\/\//, (_m, s) => `ws${s}://`)
).replace(/\/$/, '');

export const API = {
  flightsLive: `${BASE_URL}/api/v1/flights/live`,
  statsLive: `${BASE_URL}/api/v1/stats/live`,
  wsTicket: `${BASE_URL}/api/v1/ws/ticket`,
  ws: `${WS_URL}/ws`,
};

// A handful of representative viewports (map bootstrap bbox = [west,south,east,north]).
// Istanbul, London, NYC, and a wide EU box — kept small so viewport filtering is exercised.
export const VIEWPORTS = [
  [28.5, 40.7, 29.5, 41.3], // Istanbul
  [-0.6, 51.2, 0.3, 51.7], // London
  [-74.3, 40.4, -73.6, 40.95], // New York
  [-10.0, 35.0, 30.0, 60.0], // wide Europe
];

export function randomViewport() {
  return VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
}

/** bbox as the `w,s,e,n` query string used by GET /flights/live. */
export function bboxQuery(bbox) {
  return bbox.join(',');
}

// ── WS handshake ──────────────────────────────────────────────────────────────
//
// The gateway requires a short-lived, single-use ticket (docs/12 §12.7):
// POST /api/v1/ws/ticket -> { data: { token, expiresInMs } }, then connect to
// /ws?token=<token>. Tickets are consumed on upgrade, so every connection must
// mint its own — call this immediately before ws.connect().
export function mintWsTicket() {
  const res = http.post(API.wsTicket, null, {
    headers: { 'content-type': 'application/json' },
    tags: { name: 'ws-ticket' },
  });
  const okStatus = check(res, { 'ticket 200': (r) => r.status === 200 });
  if (!okStatus) return null;
  try {
    const token = res.json('data.token');
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch (_e) {
    return null;
  }
}

/** Full ws:// URL including a freshly minted ticket, or null if minting failed. */
export function wsUrlWithTicket() {
  const token = mintWsTicket();
  return token ? `${API.ws}?token=${encodeURIComponent(token)}` : null;
}

// ── Stage presets ──────────────────────────────────────────────────────────────
//
// Selected via PROFILE. HTTP presets ramp arrival-independent VUs; the *-ws
// preset targets a large steady pool of held connections. Tune the targets to
// what your box can actually push — these are starting points, documented in
// README.md, and can always be overridden per-scenario with VUS.

const MIN = 60; // seconds helper for readability

export const HTTP_PROFILES = {
  smoke: {
    stages: [
      { duration: '10s', target: 5 },
      { duration: '20s', target: 5 },
      { duration: '5s', target: 0 },
    ],
  },
  '1k': {
    stages: [
      { duration: '30s', target: 200 },
      { duration: '1m', target: 1000 },
      { duration: `${2 * MIN}s`, target: 1000 },
      { duration: '30s', target: 0 },
    ],
  },
  '5k': {
    stages: [
      { duration: '1m', target: 1000 },
      { duration: '2m', target: 5000 },
      { duration: '3m', target: 5000 },
      { duration: '1m', target: 0 },
    ],
  },
  '10k': {
    stages: [
      { duration: '1m', target: 2000 },
      { duration: '3m', target: 10000 },
      { duration: '5m', target: 10000 },
      { duration: '1m', target: 0 },
    ],
  },
};

// WS presets express a target of concurrent held connections. Scenarios read
// __ENV.VUS first (explicit override), then fall back to the profile target.
export const WS_PROFILES = {
  smoke: { vus: 10, ramp: '10s', hold: '30s' },
  '1k': { vus: 1000, ramp: '1m', hold: '3m' },
  '5k': { vus: 5000, ramp: '2m', hold: '3m' },
  '10k': { vus: 10000, ramp: '3m', hold: '5m' },
  '50k-ws': { vus: 50000, ramp: '5m', hold: '5m' },
};

export function profileName() {
  return __ENV.PROFILE || 'smoke';
}

/** HTTP scenario stages for the active PROFILE (falls back to smoke). */
export function httpStages() {
  const p = HTTP_PROFILES[profileName()] || HTTP_PROFILES.smoke;
  return p.stages;
}

/** Resolve WS connection target: explicit VUS wins, else the PROFILE preset. */
export function wsPlan() {
  const preset = WS_PROFILES[profileName()] || WS_PROFILES.smoke;
  const vus = Number(__ENV.VUS) > 0 ? Number(__ENV.VUS) : preset.vus;
  return { vus, ramp: preset.ramp, hold: preset.hold };
}

// Shared thresholds. p95 < 500ms, error rate < 1% (per the module spec).
export const HTTP_THRESHOLDS = {
  http_req_duration: ['p(95)<500'],
  http_req_failed: ['rate<0.01'],
  checks: ['rate>0.99'],
};
