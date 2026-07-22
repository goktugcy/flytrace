'use client';

import { apiBase } from '@/lib/api';

import type { FlightDetail, LiveFlight, WeatherMapFeatureCollection } from '@flytrace/shared';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { SearchBox } from '@/components/SearchBox';
import { ErrorState } from '@/components/ui/states';
import { contiguousTrailToAnchor } from '@/lib/flight-trail';
import { useT } from '@/lib/i18n';
import { saveLiveFlightDetail } from '@/lib/live-detail-cache';
import { type FocusTarget, readFocusFromUrl, registerMapFocus } from '@/lib/map-focus';
import { cn } from '@/lib/utils';
import {
  CloudSun,
  ExternalLink,
  Layers,
  LocateFixed,
  Plane,
  RadioTower,
  TowerControl,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { type RenderedFlight, stepRenderedFlight } from '../lib/flight-motion';
import {
  CLIENT_FLIGHT_LIFECYCLE,
  type FlightQualityState,
  type FlightSample,
  classifyFlightSample,
} from '../lib/flight-store';
import { RealtimeClient, type RealtimeStatus } from '../lib/realtime-client';

/** The live map needs a WebGL context (maplibre); some browsers/GPUs disable it. */
function webglAvailable(): boolean {
  if (typeof document === 'undefined') return true;
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch {
    return false;
  }
}

const API_BASE = apiBase();
const WS_BASE = API_BASE.replace(/^http/, 'ws');

// Theme-aware basemap: a light, Google-Maps-like style (OpenFreeMap "liberty")
// in light mode and a dark data-viz style in dark mode, switched live when the
// theme toggles. A bundled first-party geography (public/geo/world.json) is the
// offline fallback so the map always renders even when tile CDNs are blocked by
// ad/privacy extensions. NEXT_PUBLIC_MAP_STYLE_{LIGHT,DARK} override each style;
// NEXT_PUBLIC_MAP_STYLE (legacy) overrides both.
const REMOTE_STYLE_DARK =
  process.env.NEXT_PUBLIC_MAP_STYLE_DARK ??
  process.env.NEXT_PUBLIC_MAP_STYLE ??
  'https://tiles.openfreemap.org/styles/dark';
const REMOTE_STYLE_LIGHT =
  process.env.NEXT_PUBLIC_MAP_STYLE_LIGHT ??
  process.env.NEXT_PUBLIC_MAP_STYLE ??
  'https://tiles.openfreemap.org/styles/liberty';
const remoteStyleFor = (dark: boolean): string => (dark ? REMOTE_STYLE_DARK : REMOTE_STYLE_LIGHT);
const WORLD_GEOJSON_URL = '/geo/world.json';

/** Active theme, read from the <html> class the theme toggle manages. */
function prefersDark(): boolean {
  if (typeof document === 'undefined') return true;
  return document.documentElement.classList.contains('dark');
}

/** Bundled offline fallback background (tile CDN blocked), per theme. */
function baseStyleFor(dark: boolean): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': dark ? '#080d18' : '#dce6f2' } },
    ],
  };
}

/** Land / border / graticule colours for the bundled geography, per theme. */
const WORLD_COLORS = {
  dark: { fill: '#131c2b', line: '#31405a', grid: '#141d30' },
  light: { fill: '#eef2f6', line: '#b6c2d1', grid: '#e6ebf1' },
} as const;

interface SelInfo {
  flightId: string;
  icao24: string;
  callsign: string;
  lat: number;
  lon: number;
  altFt: number | null;
  geoAltitudeFt: number | null;
  gsKt: number | null;
  verticalRateFpm: number | null;
  heading: number | null;
  onGround: boolean;
  squawk: string | null;
  category: string;
  source: string | null;
  sourceTimestamp: string | null;
  ageMs: number | null;
  qualityScore: number | null;
  positionSource: string | null;
  isMlat: boolean | null;
  qualityState: FlightQualityState;
  ts: string;
  tsMs: number;
}

function toSel(f: FlightSample): SelInfo {
  return {
    flightId: f.flightId,
    icao24: f.icao24,
    callsign: f.callsign ?? f.icao24,
    lat: f.lat,
    lon: f.lon,
    altFt: f.altFt,
    geoAltitudeFt: f.geoAltitudeFt,
    gsKt: f.gsKt,
    verticalRateFpm: f.verticalRateFpm,
    heading: f.heading,
    onGround: f.onGround,
    squawk: f.squawk,
    category: flightCategory(f),
    source: f.source,
    sourceTimestamp: f.sourceTimestamp,
    ageMs: f.ageMs,
    qualityScore: f.qualityScore,
    positionSource: f.positionSource,
    isMlat: f.isMlat,
    qualityState: f.qualityState,
    ts: f.ts,
    tsMs: f.tsMs,
  };
}

interface AirspaceSummary {
  id: string;
  name: string;
  type: string;
  class: string | null;
  frequency: string | null;
  lowerFt: number | null;
  upperFt: number | null;
}

/** Top-down airliner silhouette (points north) as an SDF image for tinting + rotation. */
function makePlaneImage(size = 64): ImageData {
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext('2d');
  if (!ctx) return new ImageData(size, size);
  const s = size / 64;
  const pts: [number, number][] = [
    [32, 3],
    [34, 22],
    [34, 28],
    [61, 45],
    [61, 48],
    [34, 38],
    [34, 52],
    [46, 61],
    [46, 63],
    [32, 57],
    [18, 63],
    [18, 61],
    [30, 52],
    [30, 38],
    [3, 48],
    [3, 45],
    [30, 28],
    [30, 22],
  ];
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(pts[0][0] * s, pts[0][1] * s);
  for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i][0] * s, pts[i][1] * s);
  ctx.closePath();
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
}

function blankCtx(size: number): { ctx: CanvasRenderingContext2D | null; s: number } {
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext('2d');
  if (ctx) ctx.fillStyle = '#fff';
  return { ctx, s: size / 64 };
}

/** Light / general-aviation silhouette (straight high wing), points north. */
function makePropImage(size = 64): ImageData {
  const { ctx, s } = blankCtx(size);
  if (!ctx) return new ImageData(size, size);
  const r = (x: number, y: number, w: number, h: number) =>
    ctx.fillRect(x * s, y * s, w * s, h * s);
  r(29, 8, 6, 48); // fuselage
  r(6, 26, 52, 5); // straight wing
  r(23, 52, 18, 4); // tailplane
  return ctx.getImageData(0, 0, size, size);
}

/** Helicopter silhouette (rotor disc + tail boom), points north. */
function makeHeloImage(size = 64): ImageData {
  const { ctx, s } = blankCtx(size);
  if (!ctx) return new ImageData(size, size);
  const r = (x: number, y: number, w: number, h: number) =>
    ctx.fillRect(x * s, y * s, w * s, h * s);
  r(9, 29, 46, 3); // main rotor (horizontal)
  r(30, 9, 4, 40); // main rotor (vertical)
  r(26, 22, 12, 20); // body
  r(31, 42, 3, 16); // tail boom
  r(27, 57, 11, 3); // tail rotor
  return ctx.getImageData(0, 0, size, size);
}

/** Compact airport marker: runway + terminal block, SDF-tinted by airport type. */
function makeAirportImage(size = 64): ImageData {
  const { ctx, s } = blankCtx(size);
  if (!ctx) return new ImageData(size, size);
  const r = (x: number, y: number, w: number, h: number) =>
    ctx.fillRect(x * s, y * s, w * s, h * s);
  r(29, 5, 6, 54); // runway
  r(23, 11, 18, 4);
  r(23, 49, 18, 4);
  r(12, 24, 40, 16); // terminal
  r(18, 19, 8, 26);
  r(38, 19, 8, 26);
  return ctx.getImageData(0, 0, size, size);
}

type WeatherIconKind = 'storm' | 'rain' | 'wind' | 'snow' | 'fog' | 'generic';

/** Font-independent weather symbols rendered as SDF icons by MapLibre. */
function makeWeatherImage(kind: WeatherIconKind, size = 64): ImageData {
  const { ctx, s } = blankCtx(size);
  if (!ctx) return new ImageData(size, size);
  const path = (points: [number, number][], close = false) => {
    const first = points[0];
    if (!first) return;
    ctx.beginPath();
    ctx.moveTo(first[0] * s, first[1] * s);
    for (const [x, y] of points.slice(1)) ctx.lineTo(x * s, y * s);
    if (close) ctx.closePath();
  };
  const stroke = (points: [number, number][], width = 6) => {
    path(points);
    ctx.lineWidth = width * s;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  };
  const dot = (x: number, y: number, radius: number) => {
    ctx.beginPath();
    ctx.arc(x * s, y * s, radius * s, 0, Math.PI * 2);
    ctx.fill();
  };

  if (kind === 'storm') {
    path(
      [
        [37, 5],
        [16, 35],
        [29, 35],
        [23, 59],
        [49, 27],
        [35, 27],
      ],
      true,
    );
    ctx.fill();
  } else if (kind === 'rain') {
    dot(24, 27, 12);
    dot(38, 23, 15);
    ctx.fillRect(16 * s, 25 * s, 37 * s, 13 * s);
    stroke(
      [
        [20, 45],
        [17, 54],
      ],
      5,
    );
    stroke(
      [
        [33, 45],
        [30, 54],
      ],
      5,
    );
    stroke(
      [
        [46, 45],
        [43, 54],
      ],
      5,
    );
  } else if (kind === 'wind') {
    stroke(
      [
        [9, 20],
        [38, 20],
        [47, 14],
        [54, 20],
        [48, 27],
      ],
      5,
    );
    stroke(
      [
        [9, 33],
        [48, 33],
      ],
      5,
    );
    stroke(
      [
        [9, 46],
        [34, 46],
        [41, 51],
      ],
      5,
    );
  } else if (kind === 'snow') {
    stroke(
      [
        [32, 8],
        [32, 56],
      ],
      5,
    );
    stroke(
      [
        [11, 20],
        [53, 44],
      ],
      5,
    );
    stroke(
      [
        [53, 20],
        [11, 44],
      ],
      5,
    );
    dot(32, 32, 5);
  } else if (kind === 'fog') {
    stroke(
      [
        [10, 20],
        [54, 20],
      ],
      6,
    );
    stroke(
      [
        [15, 32],
        [49, 32],
      ],
      6,
    );
    stroke(
      [
        [10, 44],
        [54, 44],
      ],
      6,
    );
  } else {
    dot(32, 32, 16);
  }

  return ctx.getImageData(0, 0, size, size);
}

const CAT_SIZE: Record<string, number> = { light: 0.72, jet: 1.0, heavy: 1.35, helo: 0.9 };

/** Faint lat/lon graticule for depth. */
function graticule(step = 10): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  const line = (coords: [number, number][]): GeoJSON.Feature => ({
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: coords },
    properties: {},
  });
  for (let lon = -180; lon <= 180; lon += step) {
    const c: [number, number][] = [];
    for (let lat = -80; lat <= 80; lat += 5) c.push([lon, lat]);
    features.push(line(c));
  }
  for (let lat = -80; lat <= 80; lat += step) {
    features.push(
      line([
        [-180, lat],
        [0, lat],
        [180, lat],
      ]),
    );
  }
  return { type: 'FeatureCollection', features };
}

// Prefer the real ADS-B emitter category; otherwise fall back to a coarse
// class inferred from altitude/speed so every aircraft still gets an icon.
function flightCategory(f: FlightSample): string {
  if (f.category) return f.category;
  if (!f.onGround && (f.gsKt ?? 0) < 160 && (f.altFt ?? 0) < 10000) return 'light';
  if ((f.altFt ?? 0) >= 30000) return 'heavy';
  return 'jet';
}

/** Altitude → colour ramp (Flightradar-ish). */
const ALT_COLOR: maplibregl.ExpressionSpecification = [
  'case',
  ['==', ['get', 'onGround'], 1],
  '#9ca3af',
  [
    'interpolate',
    ['linear'],
    ['get', 'alt'],
    0,
    '#22c55e',
    5000,
    '#84cc16',
    15000,
    '#eab308',
    25000,
    '#fb923c',
    35000,
    '#38bdf8',
    45000,
    '#e2e8f0',
  ],
];

// Zoom is the top-level interpolate input; the per-feature size class is a
// multiplier in the outputs (maplibre forbids zoom nested in other expressions).
const ICON_SIZE: maplibregl.ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['zoom'],
  3,
  ['*', 0.5, ['get', 'sizeMul']],
  6,
  ['*', 0.72, ['get', 'sizeMul']],
  9,
  ['*', 0.95, ['get', 'sizeMul']],
];

const AIRSPACE_MIN_ZOOM = 5.2;
const AIRSPACE_TYPES_QUERY = 'CTR,TMA,CTA,RESTRICTED,DANGER,PROHIBITED';
const EMPTY_FEATURES: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const AIRPORT_POLL_MS = 12_000;
const WEATHER_POLL_MS = 5 * 60_000;
const VIEWPORT_LIVE_MIN_ZOOM = 3;
const VIEWPORT_LIVE_POLL_MS = 5_000;
const FLIGHT_FRAME_IDLE_MS = 100;
const FLIGHT_FRAME_MOVING_MS = 180;
const FLIGHT_MAINTENANCE_MS = 1_000;
const MAP_FLIGHT_LIFECYCLE = {
  ...CLIENT_FLIGHT_LIFECYCLE,
  removeAfterMs: 5 * 60_000,
};
const LIVE_TRAIL_MIN_DEG = 0.00065; // ~70 m — skips ADS-B jitter.
const LIVE_TRAIL_RESET_DEG = 8; // Teleport / reused id guard.
const LIVE_TRAIL_MAX_POINTS = 120;
const LIVE_TRAIL_RETENTION_MS = 45 * 60_000;

const AIRSPACE_FILL_COLOR: maplibregl.ExpressionSpecification = [
  'match',
  ['get', 'type'],
  'CTR',
  '#38bdf8',
  'TMA',
  '#a78bfa',
  'CTA',
  '#22c55e',
  'RESTRICTED',
  '#f97316',
  'DANGER',
  '#ef4444',
  'PROHIBITED',
  '#dc2626',
  '#64748b',
];

const AIRSPACE_LINE_COLOR: maplibregl.ExpressionSpecification = [
  'match',
  ['get', 'type'],
  'CTR',
  '#7dd3fc',
  'TMA',
  '#c4b5fd',
  'CTA',
  '#86efac',
  'RESTRICTED',
  '#fdba74',
  'DANGER',
  '#fca5a5',
  'PROHIBITED',
  '#fecaca',
  '#94a3b8',
];

const AIRPORT_COLOR: maplibregl.ExpressionSpecification = [
  'match',
  ['get', 'type'],
  'large_airport',
  '#f8fafc',
  'medium_airport',
  '#7dd3fc',
  'small_airport',
  '#86efac',
  'heliport',
  '#fbbf24',
  'seaplane_base',
  '#67e8f9',
  '#cbd5e1',
];

const WEATHER_COLOR: maplibregl.ExpressionSpecification = [
  'match',
  ['get', 'severity'],
  'severe',
  '#ef4444',
  'high',
  '#f97316',
  'moderate',
  '#fbbf24',
  'low',
  '#38bdf8',
  '#94a3b8',
];

const WEATHER_ICON: maplibregl.ExpressionSpecification = [
  'match',
  ['get', 'kind'],
  'storm',
  'weather-storm',
  'rain',
  'weather-rain',
  'wind',
  'weather-wind',
  'snow',
  'weather-snow',
  'fog',
  'weather-fog',
  'weather-generic',
];

interface RouteAirport {
  iata: string;
  name: string;
  city: string | null;
  lat: number;
  lon: number;
}
interface RouteInfo {
  airline: string | null;
  origin: RouteAirport;
  destination: RouteAirport;
  source: 'database' | 'aerodatabox' | 'adsbdb';
  confidence: number;
}

interface AirportPhoto {
  url: string;
  pageUrl: string | null;
  source: string;
}

interface AirportDetail {
  id: string;
  iata: string | null;
  icao: string;
  name: string;
  type: string | null;
  city: string | null;
  country: string | null;
  timezone: string | null;
  elevationFt: number | null;
  lat: number | null;
  lon: number | null;
  runways: unknown;
  scheduledService: boolean;
  homeUrl: string | null;
  wikipediaUrl: string | null;
  keywords: string | null;
  photo: AirportPhoto | null;
}

interface AirportFeatureCollection extends GeoJSON.FeatureCollection {
  count?: number;
}

interface LiveTrailState {
  coords: [number, number][];
  last: [number, number] | null;
  lastTsMs: number;
  lastSeenMs: number;
  quality: FlightQualityState;
}

interface LiveTrackSeed {
  flightId: string;
  persistedFlightId: string;
  transientFlightId: string | null;
  points: {
    ts: string;
    icao24: string | null;
    lat: number | null;
    lon: number | null;
    altitudeFt: number | null;
    headingDeg: number | null;
  }[];
  count: number;
}

/** Great-circle polyline between two [lon,lat] points (curved route line). */
function greatCircle(from: [number, number], to: [number, number], n = 64): [number, number][] {
  const rad = Math.PI / 180;
  const deg = 180 / Math.PI;
  const lon1 = from[0] * rad;
  const lat1 = from[1] * rad;
  const lon2 = to[0] * rad;
  const lat2 = to[1] * rad;
  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((lat2 - lat1) / 2) ** 2 +
          Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2,
      ),
    );
  if (d === 0) return [from, to];
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i += 1) {
    const f = i / n;
    const a = Math.sin((1 - f) * d) / Math.sin(d);
    const b = Math.sin(f * d) / Math.sin(d);
    const x = a * Math.cos(lat1) * Math.cos(lon1) + b * Math.cos(lat2) * Math.cos(lon2);
    const y = a * Math.cos(lat1) * Math.sin(lon1) + b * Math.cos(lat2) * Math.sin(lon2);
    const z = a * Math.sin(lat1) + b * Math.sin(lat2);
    pts.push([Math.atan2(y, x) * deg, Math.atan2(z, Math.sqrt(x * x + y * y)) * deg]);
  }
  return pts;
}

type Band = 'all' | 'low' | 'mid' | 'high';

/** Build a maplibre filter for the flights layer from the UI filter state. */
function buildFilter(f: { band: Band; airline: string }): maplibregl.FilterSpecification | null {
  const parts: unknown[] = [];
  if (f.band === 'low') parts.push(['<', ['get', 'alt'], 10000]);
  else if (f.band === 'mid')
    parts.push(['all', ['>=', ['get', 'alt'], 10000], ['<', ['get', 'alt'], 30000]]);
  else if (f.band === 'high') parts.push(['>=', ['get', 'alt'], 30000]);
  const a = f.airline.trim().toUpperCase();
  if (a) parts.push(['==', ['slice', ['get', 'callsign'], 0, a.length], a]);
  if (parts.length === 0) return null;
  return ['all', ...parts] as unknown as maplibregl.FilterSpecification;
}

function viewportBbox(map: maplibregl.Map): [number, number, number, number] | null {
  const b = map.getBounds();
  const rawWest = b.getWest();
  const rawEast = b.getEast();
  const south = clampLat(b.getSouth());
  const north = clampLat(b.getNorth());
  if (south >= north) return null;
  if (Math.abs(rawEast - rawWest) >= 360) return [-180, south, 180, north];
  return [wrapLng(rawWest), south, wrapLng(rawEast), north];
}

function clampLat(lat: number): number {
  return Math.max(-90, Math.min(90, lat));
}

function wrapLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

function weatherPopupNode(properties: Record<string, unknown>): HTMLElement {
  const root = document.createElement('div');
  root.className = 'flt-tip weather-tip';
  const title = document.createElement('b');
  title.textContent = String(properties.label ?? 'Weather');
  root.append(title);

  const measurements = document.createElement('span');
  const parts = [
    numericLabel(properties.precipitationMm, 'mm precipitation'),
    numericLabel(properties.gustKt, 'kt gust'),
    numericLabel(properties.capeJkg, 'J/kg CAPE'),
  ].filter(Boolean);
  measurements.textContent = parts.length > 0 ? parts.join(' · ') : 'Current model sample';
  root.append(measurements);

  const source = document.createElement('span');
  source.textContent = `Open-Meteo · ${String(properties.severity ?? 'none')} risk`;
  root.append(source);
  return root;
}

function weatherSoundPath(properties: Record<string, unknown>): string | null {
  const kind = String(properties.kind ?? '');
  if (kind === 'rain') return '/audio/weather/rain.wav';
  if (kind === 'wind') return '/audio/weather/wind.wav';
  if (kind !== 'storm') return null;

  const precipitation = properties.precipitationMm;
  return typeof precipitation === 'number' && precipitation > 0.05
    ? '/audio/weather/rain-thunderstorm.wav'
    : '/audio/weather/thunder.wav';
}

function aircraftSoundPath(category: unknown): string {
  if (category === 'helo') return '/audio/aircraft/helicopter.wav';
  if (category === 'light') return '/audio/aircraft/traine-plane.wav';
  return '/audio/aircraft/plane.wav';
}

function numericLabel(value: unknown, suffix: string): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return `${Math.round(value * 10) / 10} ${suffix}`;
}

function liveFlightToSnapshot(f: LiveFlight) {
  return {
    flightId: f.flightId,
    icao24: f.icao24,
    callsign: f.callsign,
    lat: f.lat,
    lon: f.lon,
    headingDeg: f.headingDeg,
    altFt: f.altitudeFt,
    geoAltitudeFt: f.geoAltitudeFt,
    gsKt: f.groundSpeedKt,
    verticalRateFpm: f.verticalRateFpm,
    onGround: f.onGround,
    squawk: f.squawk,
    category: f.category,
    source: f.source,
    sourceTimestamp: f.sourceTimestamp,
    ageMs: f.ageMs,
    qualityScore: f.qualityScore,
    positionSource: f.positionSource,
    isMlat: f.isMlat,
    qualityState: f.qualityState,
    lastAcceptedAt: f.receivedAt,
    lastTs: f.ts,
  };
}

function liveDetailFromSelection(sel: SelInfo): FlightDetail {
  const live: NonNullable<FlightDetail['live']> = {
    flightId: sel.flightId,
    icao24: sel.icao24,
    callsign: sel.callsign,
    lat: sel.lat,
    lon: sel.lon,
    altitudeFt: sel.altFt,
    geoAltitudeFt: sel.geoAltitudeFt,
    headingDeg: sel.heading,
    groundSpeedKt: sel.gsKt,
    verticalRateFpm: sel.verticalRateFpm,
    onGround: sel.onGround,
    squawk: sel.squawk,
    category: sel.category,
    qualityState: sel.qualityState,
    source: sel.source,
    ts: sel.ts,
    ...(sel.sourceTimestamp ? { sourceTimestamp: sel.sourceTimestamp } : {}),
    ...(sel.ageMs != null ? { ageMs: Math.max(0, Math.round(sel.ageMs)) } : {}),
    ...(sel.qualityScore != null ? { qualityScore: sel.qualityScore } : {}),
    ...(sel.positionSource ? { positionSource: sel.positionSource } : {}),
    ...(sel.isMlat != null ? { isMlat: sel.isMlat } : {}),
    receivedAt: new Date().toISOString(),
  };

  return {
    flight: {
      flightId: sel.flightId,
      callsign: sel.callsign,
      flightNumber: null,
      status: sel.onGround ? 'landed' : 'active',
      flightDate: sel.ts.slice(0, 10),
      source: sel.source ?? 'adsb',
    },
    live,
    statusSnapshot: null,
    timeline: [],
  };
}

function cacheSelectedLiveDetail(sel: SelInfo): void {
  saveLiveFlightDetail(liveDetailFromSelection(sel));
}

export function LiveMap() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const selectRef = useRef<(id: string | null) => void>(() => {});
  const locateRef = useRef<() => void>(() => {});
  const [count, setCount] = useState(0);
  const [failed, setFailed] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<RealtimeStatus>('disconnected');
  const [sel, setSel] = useState<SelInfo | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [route, setRoute] = useState<RouteInfo | null>(null);
  const [airportsEnabled, setAirportsEnabled] = useState(true);
  const [airportCount, setAirportCount] = useState(0);
  const [airportStatus, setAirportStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );
  const [selAirport, setSelAirport] = useState<AirportDetail | null>(null);
  const [selectedAirportStatus, setSelectedAirportStatus] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');
  const [airspaceEnabled, setAirspaceEnabled] = useState(false);
  const [airspaceCount, setAirspaceCount] = useState(0);
  const [airspaceStatus, setAirspaceStatus] = useState<
    'idle' | 'loading' | 'ready' | 'zoom' | 'error'
  >('idle');
  const [weatherEnabled, setWeatherEnabled] = useState(true);
  const [weatherCount, setWeatherCount] = useState(0);
  const [weatherStatus, setWeatherStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );
  const [selectedAirspaces, setSelectedAirspaces] = useState<AirspaceSummary[]>([]);
  const [selectedAirspaceStatus, setSelectedAirspaceStatus] = useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle');
  const [band, setBand] = useState<Band>('all');
  const [airline, setAirline] = useState('');
  const filterRef = useRef<{ band: Band; airline: string }>({ band: 'all', airline: '' });
  const applyFilterRef = useRef<() => void>(() => {});
  const airportsEnabledRef = useRef(true);
  const applyAirportsRef = useRef<() => void>(() => {});
  const airportDetailSeqRef = useRef(0);
  const airspaceEnabledRef = useRef(false);
  const applyAirspaceRef = useRef<() => void>(() => {});
  const weatherEnabledRef = useRef(true);
  const applyWeatherRef = useRef<() => void>(() => {});
  const selectedAirspaceRef = useRef<SelInfo | null>(null);
  const t = useT();

  const changeBand = (b: Band) => {
    setBand(b);
    filterRef.current.band = b;
    applyFilterRef.current();
  };
  const changeAirline = (v: string) => {
    setAirline(v);
    filterRef.current.airline = v;
    applyFilterRef.current();
  };
  const toggleAirspace = () => {
    const next = !airspaceEnabledRef.current;
    airspaceEnabledRef.current = next;
    setAirspaceEnabled(next);
    applyAirspaceRef.current();
  };
  const toggleAirports = () => {
    const next = !airportsEnabledRef.current;
    airportsEnabledRef.current = next;
    setAirportsEnabled(next);
    applyAirportsRef.current();
  };
  const toggleWeather = () => {
    const next = !weatherEnabledRef.current;
    weatherEnabledRef.current = next;
    setWeatherEnabled(next);
    applyWeatherRef.current();
  };

  useEffect(() => {
    if (!containerRef.current) return;
    if (!webglAvailable()) {
      setFailed(true);
      return;
    }

    let map: maplibregl.Map;
    let usingRemote = true;
    let currentDark = prefersDark();
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: remoteStyleFor(currentDark),
        center: [35, 39],
        zoom: 5,
        attributionControl: false,
        maxZoom: 12,
      });
    } catch {
      setFailed(true);
      return;
    }

    // Swap the basemap live when the app theme toggles (light ⇄ dark). Carry our
    // DATA overlays (aircraft, trails, selection, route, airports, airspaces)
    // into the new style via transformStyle so they never blink out while the
    // new basemap loads; world/grid are theme-coloured, so ensureLayers re-adds
    // those. `carrySwap` tells style.load to skip the airport/airspace refetch
    // since that data came across with the layers.
    let carrySwap = false;
    const isCarried = (id: string) => OURS.has(id) && id !== 'world' && id !== 'grid';
    const applyBasemap = () => {
      carrySwap = true;
      map.setStyle(usingRemote ? remoteStyleFor(currentDark) : baseStyleFor(currentDark), {
        transformStyle: (prev, next) => {
          if (!prev) return next;
          const sources = { ...next.sources };
          for (const [id, src] of Object.entries(prev.sources)) {
            if (isCarried(id)) sources[id] = src;
          }
          const carried = prev.layers.filter(
            (l) => 'source' in l && typeof l.source === 'string' && isCarried(l.source),
          );
          return { ...next, sources, layers: [...next.layers, ...carried] };
        },
      });
    };
    const themeObserver = new MutationObserver(() => {
      const dark = prefersDark();
      if (dark !== currentDark) {
        currentDark = dark;
        applyBasemap();
      }
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    map.addControl(new maplibregl.NavigationControl({ showZoom: true }), 'top-right');
    map.addControl(
      new maplibregl.AttributionControl({
        customAttribution: 'Positions © OpenSky Network · Weather © Open-Meteo · © MapLibre',
      }),
    );

    const resize = () => map.resize();
    requestAnimationFrame(resize);
    const ro = new ResizeObserver(resize);
    ro.observe(containerRef.current);

    const client = new RealtimeClient({ apiBase: API_BASE, wsBase: WS_BASE });
    const offStatus = client.onStatus(setConnectionStatus);
    const rendered = new Map<string, RenderedFlight>();
    let raf = 0;
    let started = false;
    let remoteTileOk = false;
    const OURS = new Set([
      'world',
      'grid',
      'flights',
      'live-trails',
      'trail',
      'selected',
      'route',
      'route-ends',
      'airports',
      'airspaces',
      'weather',
    ]);
    let selectedId: string | null = null;
    let pulse = 0;
    let airportSeq = 0;
    let airportTimer: ReturnType<typeof setTimeout> | null = null;
    let airportInterval: ReturnType<typeof setInterval> | null = null;
    let airspaceSeq = 0;
    let airspaceTimer: ReturnType<typeof setTimeout> | null = null;
    let weatherSeq = 0;
    let weatherTimer: ReturnType<typeof setTimeout> | null = null;
    let weatherInterval: ReturnType<typeof setInterval> | null = null;
    let weatherAbort: AbortController | null = null;
    let weatherPopup: maplibregl.Popup | null = null;
    let ambientAudio: HTMLAudioElement | null = null;
    let ambientAudioKey: string | null = null;
    let ambientAudioVersion = 0;
    let weatherPulse = 0;
    let weatherPulseLastRender = 0;
    let viewportLiveSeq = 0;
    let viewportLiveTimer: ReturnType<typeof setTimeout> | null = null;
    let viewportLiveInterval: ReturnType<typeof setInterval> | null = null;
    let viewportLiveAbort: AbortController | null = null;
    const liveTrails = new Map<string, LiveTrailState>();
    const liveTrailSeeded = new Set<string>();
    let liveTrailsDirty = false;
    let liveTrailsLastRender = 0;
    let flightFrameLastRender = 0;
    let flightMaintenanceLastRun = 0;

    const stopAmbientAudio = () => {
      ambientAudioVersion += 1;
      if (ambientAudio) {
        ambientAudio.pause();
      }
      ambientAudio = null;
      ambientAudioKey = null;
    };

    const toggleAmbientAudio = (key: string, path: string | null) => {
      if (!path || (ambientAudioKey === key && ambientAudio && !ambientAudio.paused)) {
        stopAmbientAudio();
        return;
      }

      stopAmbientAudio();
      const version = ambientAudioVersion;
      const audio = new Audio(path);
      audio.loop = true;
      audio.preload = 'auto';
      audio.volume = 0.45;
      ambientAudio = audio;
      ambientAudioKey = key;
      void audio.play().catch(() => {
        if (ambientAudioVersion === version && ambientAudio === audio) stopAmbientAudio();
      });
    };

    const toggleWeatherAudio = (properties: Record<string, unknown>) => {
      const id = String(properties.id ?? `${properties.kind}:${properties.observedAt}`);
      toggleAmbientAudio(`weather:${id}`, weatherSoundPath(properties));
    };

    const featureCollection = (): GeoJSON.FeatureCollection => ({
      type: 'FeatureCollection',
      features: client.store.list().map((f) => {
        const r = rendered.get(f.flightId) ?? { lat: f.lat, lon: f.lon, hdg: f.heading ?? 0 };
        const cat = flightCategory(f);
        const quality = classifyFlightSample(f, Date.now());
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
          properties: {
            flightId: f.flightId,
            callsign: f.callsign ?? f.icao24,
            heading: r.hdg,
            alt: f.altFt ?? 0,
            gs: f.gsKt ?? 0,
            cat,
            sizeMul: CAT_SIZE[cat] ?? 1,
            onGround: f.onGround ? 1 : 0,
            quality,
          },
        };
      }),
    });

    const selectedFeature = (): GeoJSON.FeatureCollection => {
      const f = selectedId ? client.store.get(selectedId) : undefined;
      const r = selectedId ? rendered.get(selectedId) : undefined;
      if (!f || !r) return { type: 'FeatureCollection', features: [] };
      return {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
            properties: {},
          },
        ],
      };
    };

    const renderLiveTrails = (force = false) => {
      const now = Date.now();
      if (!force && (!liveTrailsDirty || now - liveTrailsLastRender < 220)) return;
      const src = map.getSource('live-trails') as maplibregl.GeoJSONSource | undefined;
      if (!src) return;
      liveTrailsDirty = false;
      liveTrailsLastRender = now;
      src.setData({
        type: 'FeatureCollection',
        features: [...liveTrails.entries()]
          .filter(([flightId]) => flightId === selectedId)
          .filter(([, trail]) => trail.coords.length >= 2)
          .map(([flightId, trail]) => ({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: trail.coords },
            properties: {
              flightId,
              selected: flightId === selectedId ? 1 : 0,
              quality: trail.quality,
            },
          })),
      });
    };

    const updateLiveTrail = (f: FlightSample, nowMs: number) => {
      let trail = liveTrails.get(f.flightId);
      const point: [number, number] = [f.lon, f.lat];
      if (!trail) {
        trail = {
          coords: [point],
          last: point,
          lastTsMs: f.tsMs,
          lastSeenMs: nowMs,
          quality: f.qualityState,
        };
        liveTrails.set(f.flightId, trail);
        liveTrailsDirty = true;
        return;
      }

      trail.lastSeenMs = nowMs;
      trail.quality = f.qualityState;
      if (f.tsMs < trail.lastTsMs) return;
      const d = trail.last
        ? Math.abs(point[0] - trail.last[0]) + Math.abs(point[1] - trail.last[1])
        : 0;
      if (d > LIVE_TRAIL_RESET_DEG) {
        trail.coords = [point];
        trail.last = point;
        trail.lastTsMs = f.tsMs;
        liveTrailsDirty = true;
        return;
      }
      if (f.tsMs === trail.lastTsMs && d < LIVE_TRAIL_MIN_DEG) return;
      if (d < LIVE_TRAIL_MIN_DEG) {
        trail.lastTsMs = Math.max(trail.lastTsMs, f.tsMs);
        return;
      }
      trail.coords.push(point);
      if (trail.coords.length > LIVE_TRAIL_MAX_POINTS) {
        trail.coords.splice(0, trail.coords.length - LIVE_TRAIL_MAX_POINTS);
      }
      trail.last = point;
      trail.lastTsMs = f.tsMs;
      liveTrailsDirty = true;
    };

    const pruneLiveTrails = (nowMs: number) => {
      const liveIds = new Set(client.store.list().map((f) => f.flightId));
      for (const [flightId, trail] of liveTrails) {
        if (liveIds.has(flightId)) continue;
        if (nowMs - trail.lastSeenMs > LIVE_TRAIL_RETENTION_MS) {
          liveTrails.delete(flightId);
          liveTrailsDirty = true;
        }
      }
    };

    const seedLiveTrailHistory = async (samples: FlightSample[] = client.store.list()) => {
      const candidates = samples
        .filter((f) => !liveTrailSeeded.has(f.flightId))
        .filter((f) => /^[0-9a-f]{6}$/i.test(f.icao24) || !f.flightId.startsWith('adsb:'))
        .slice(0, 160);
      if (candidates.length === 0) return;
      for (const f of candidates) liveTrailSeeded.add(f.flightId);

      try {
        const res = await fetch(`${API_BASE}/api/v1/flights/live/tracks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            flights: candidates.map((f) => ({
              flightId: f.flightId,
              icao24: f.flightId.startsWith('adsb:') ? f.icao24 : undefined,
              callsign: f.callsign,
              ts: f.ts,
            })),
            limitPerFlight: LIVE_TRAIL_MAX_POINTS,
            sinceMinutes: 12 * 60,
          }),
        });
        if (!res.ok) throw new Error(`track seed ${res.status}`);
        const tracks = ((await res.json()) as { data?: { tracks?: LiveTrackSeed[] } }).data?.tracks;
        if (!Array.isArray(tracks)) return;

        const nowMs = Date.now();
        for (const track of tracks) {
          const live = client.store.get(track.flightId);
          if (!live) continue;
          const coords = contiguousTrailToAnchor(track.points, live);
          if (coords.length < 2) continue;

          const trimmed =
            coords.length > LIVE_TRAIL_MAX_POINTS
              ? coords.slice(coords.length - LIVE_TRAIL_MAX_POINTS)
              : coords;
          liveTrails.set(track.flightId, {
            coords: trimmed,
            last: trimmed[trimmed.length - 1] ?? null,
            lastTsMs: live.tsMs,
            lastSeenMs: nowMs,
            quality: live.qualityState,
          });
          liveTrailsDirty = true;
        }
        renderLiveTrails(true);
      } catch {
        for (const f of candidates) liveTrailSeeded.delete(f.flightId);
      }
    };

    // Live trail buffer for the selected flight: seeded from the DB track
    // (loadTrail) and extended every time the animated marker moves far enough,
    // so the path draws + grows in real time even when DB history is shallow.
    let trailCoords: [number, number][] = [];
    let trailLast: [number, number] | null = null;
    const TRAIL_MIN_DEG = 0.0008; // ~90 m — append threshold (skips jitter)
    const TRAIL_MAX = 3000;
    const renderTrail = () => {
      const trail = map.getSource('trail') as maplibregl.GeoJSONSource | undefined;
      if (trail)
        trail.setData({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: trailCoords },
          properties: {},
        });
    };

    const tick = () => {
      const nowMs = Date.now();
      if (nowMs - flightMaintenanceLastRun >= FLIGHT_MAINTENANCE_MS) {
        client.store.pruneStale(nowMs, MAP_FLIGHT_LIFECYCLE);
        pruneLiveTrails(nowMs);
        flightMaintenanceLastRun = nowMs;
      }

      const frameInterval = map.isMoving() ? FLIGHT_FRAME_MOVING_MS : FLIGHT_FRAME_IDLE_MS;
      if (nowMs - flightFrameLastRender < frameInterval) {
        raf = requestAnimationFrame(tick);
        return;
      }

      for (const f of client.store.list()) {
        updateLiveTrail(f, nowMs);
        const next = stepRenderedFlight(rendered.get(f.flightId), f, nowMs);
        rendered.set(f.flightId, next);
      }
      for (const id of rendered.keys()) if (!client.store.get(id)) rendered.delete(id);

      // Extend the selected flight's trail as its marker advances.
      if (selectedId) {
        const r = rendered.get(selectedId);
        if (
          r &&
          (!trailLast ||
            Math.abs(r.lon - trailLast[0]) + Math.abs(r.lat - trailLast[1]) > TRAIL_MIN_DEG)
        ) {
          trailCoords.push([r.lon, r.lat]);
          if (trailCoords.length > TRAIL_MAX) trailCoords.shift();
          trailLast = [r.lon, r.lat];
          renderTrail();
        }
      }

      const src = map.getSource('flights') as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(featureCollection());
      renderLiveTrails();

      const selSrc = map.getSource('selected') as maplibregl.GeoJSONSource | undefined;
      if (selSrc) selSrc.setData(selectedFeature());
      if (selectedId && map.getLayer('sel-ring')) {
        pulse += 0.05;
        map.setPaintProperty('sel-ring', 'circle-radius', 16 + Math.sin(pulse) * 4);
        map.setPaintProperty('sel-ring', 'circle-opacity', 0.18 + (Math.sin(pulse) + 1) * 0.06);
      }
      if (
        weatherEnabledRef.current &&
        nowMs - weatherPulseLastRender >= 140 &&
        map.getLayer('weather-glow')
      ) {
        weatherPulse += 0.22;
        const wave = (Math.sin(weatherPulse) + 1) / 2;
        map.setPaintProperty('weather-glow', 'circle-radius', [
          'case',
          ['==', ['get', 'kind'], 'storm'],
          14 + wave * 7,
          11,
        ]);
        map.setPaintProperty('weather-glow', 'circle-opacity', [
          'case',
          ['==', ['get', 'kind'], 'storm'],
          0.1 + (1 - wave) * 0.18,
          0.1,
        ]);
        weatherPulseLastRender = nowMs;
      }
      flightFrameLastRender = nowMs;
      raf = requestAnimationFrame(tick);
    };

    const sendViewport = () => {
      const bbox = viewportBbox(map);
      if (bbox) client.setViewport(bbox);
      scheduleViewportLive();
    };

    const loadViewportLive = async () => {
      const seq = ++viewportLiveSeq;
      if (map.getZoom() < VIEWPORT_LIVE_MIN_ZOOM) return;
      viewportLiveAbort?.abort();
      const controller = new AbortController();
      viewportLiveAbort = controller;
      try {
        const bbox = viewportBbox(map);
        if (!bbox) return;
        const params = new URLSearchParams({
          bbox: bbox.map((v) => v.toFixed(5)).join(','),
        });
        const res = await fetch(`${API_BASE}/api/v1/flights/live/viewport?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`viewport live ${res.status}`);
        const data = (
          (await res.json()) as {
            data?: { flights?: LiveFlight[] };
          }
        ).data;
        if (seq !== viewportLiveSeq) return;
        const flights = Array.isArray(data?.flights) ? data.flights : [];
        const snapshots = flights.map(liveFlightToSnapshot);
        // This endpoint merges tracker hot state with supplemental global ADS-B.
        // It is not authoritative for absence, so never reconcile existing rows
        // against a temporarily empty/partial provider response.
        client.store.applySnapshot(snapshots, {
          generatedAt: new Date().toISOString(),
        });
        const incomingIds = new Set(snapshots.map((f) => f.flightId));
        void seedLiveTrailHistory(client.store.list().filter((f) => incomingIds.has(f.flightId)));
        setCount(client.store.size);
      } catch {
        /* live viewport is supplemental; keep realtime feed/UI running */
      } finally {
        if (viewportLiveAbort === controller) viewportLiveAbort = null;
      }
    };

    const scheduleViewportLive = (delayMs = 80) => {
      if (viewportLiveTimer) clearTimeout(viewportLiveTimer);
      viewportLiveTimer = setTimeout(() => void loadViewportLive(), delayMs);
    };

    const setAirportMapData = (data: GeoJSON.FeatureCollection) => {
      const src = map.getSource('airports') as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(data);
    };

    const setAirportVisibility = () => {
      const visibility = airportsEnabledRef.current ? 'visible' : 'none';
      for (const layer of ['airports', 'airport-labels']) {
        if (map.getLayer(layer)) map.setLayoutProperty(layer, 'visibility', visibility);
      }
    };

    const loadAirports = async () => {
      const seq = ++airportSeq;
      if (!airportsEnabledRef.current) {
        setAirportMapData(EMPTY_FEATURES);
        setAirportCount(0);
        setAirportStatus('idle');
        return;
      }
      try {
        setAirportStatus('loading');
        const bbox = viewportBbox(map);
        if (!bbox) return;
        const params = new URLSearchParams({
          bbox: bbox.map((v) => v.toFixed(5)).join(','),
          zoom: map.getZoom().toFixed(2),
          limit: '1600',
        });
        const res = await fetch(`${API_BASE}/api/v1/airports/viewport?${params.toString()}`);
        if (!res.ok) throw new Error(`airports ${res.status}`);
        const data = ((await res.json()) as { data: AirportFeatureCollection }).data;
        if (seq !== airportSeq) return;
        setAirportMapData(data);
        setAirportCount(data.count ?? data.features.length);
        setAirportStatus('ready');
      } catch {
        if (seq !== airportSeq) return;
        setAirportMapData(EMPTY_FEATURES);
        setAirportCount(0);
        setAirportStatus('error');
      }
    };

    const scheduleAirportLoad = () => {
      if (airportTimer) clearTimeout(airportTimer);
      airportTimer = setTimeout(() => void loadAirports(), 220);
    };

    applyAirportsRef.current = () => {
      setAirportVisibility();
      scheduleAirportLoad();
    };

    const setWeatherMapData = (data: GeoJSON.FeatureCollection) => {
      const src = map.getSource('weather') as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(data);
    };

    const setWeatherVisibility = () => {
      const visibility = weatherEnabledRef.current ? 'visible' : 'none';
      for (const layer of ['weather-glow', 'weather-core', 'weather-symbol', 'weather-label']) {
        if (map.getLayer(layer)) map.setLayoutProperty(layer, 'visibility', visibility);
      }
    };

    const loadWeather = async () => {
      const seq = ++weatherSeq;
      weatherAbort?.abort();
      if (!weatherEnabledRef.current) {
        setWeatherMapData(EMPTY_FEATURES);
        setWeatherCount(0);
        setWeatherStatus('idle');
        return;
      }
      const controller = new AbortController();
      weatherAbort = controller;
      try {
        setWeatherStatus('loading');
        const bbox = viewportBbox(map);
        if (!bbox) return;
        const params = new URLSearchParams({
          bbox: bbox.map((value) => value.toFixed(4)).join(','),
          zoom: map.getZoom().toFixed(2),
        });
        const response = await fetch(`${API_BASE}/api/v1/weather/viewport?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`weather ${response.status}`);
        const data = ((await response.json()) as { data: WeatherMapFeatureCollection }).data;
        if (seq !== weatherSeq) return;
        setWeatherMapData(data as GeoJSON.FeatureCollection);
        setWeatherCount(data.count);
        setWeatherStatus('ready');
      } catch (error) {
        if (seq !== weatherSeq || (error as Error).name === 'AbortError') return;
        setWeatherMapData(EMPTY_FEATURES);
        setWeatherCount(0);
        setWeatherStatus('error');
      } finally {
        if (weatherAbort === controller) weatherAbort = null;
      }
    };

    const scheduleWeatherLoad = (delayMs = 650) => {
      if (weatherTimer) clearTimeout(weatherTimer);
      weatherTimer = setTimeout(() => void loadWeather(), delayMs);
    };

    applyWeatherRef.current = () => {
      if (!weatherEnabledRef.current && ambientAudioKey?.startsWith('weather:')) stopAmbientAudio();
      setWeatherVisibility();
      scheduleWeatherLoad(0);
    };

    const setAirspaceMapData = (data: GeoJSON.FeatureCollection) => {
      const src = map.getSource('airspaces') as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(data);
    };

    const setAirspaceVisibility = () => {
      const visibility = airspaceEnabledRef.current ? 'visible' : 'none';
      for (const layer of ['airspace-fill', 'airspace-line', 'airspace-label']) {
        if (map.getLayer(layer)) map.setLayoutProperty(layer, 'visibility', visibility);
      }
    };

    const loadAirspaces = async () => {
      const seq = ++airspaceSeq;
      if (!airspaceEnabledRef.current) {
        setAirspaceMapData(EMPTY_FEATURES);
        setAirspaceCount(0);
        setAirspaceStatus('idle');
        return;
      }
      if (map.getZoom() < AIRSPACE_MIN_ZOOM) {
        setAirspaceMapData(EMPTY_FEATURES);
        setAirspaceCount(0);
        setAirspaceStatus('zoom');
        return;
      }
      try {
        setAirspaceStatus('loading');
        const b = map.getBounds();
        const west = Math.max(-180, b.getWest());
        const south = Math.max(-90, b.getSouth());
        const east = Math.min(180, b.getEast());
        const north = Math.min(90, b.getNorth());
        const params = new URLSearchParams({
          bbox: [west, south, east, north].map((v) => v.toFixed(5)).join(','),
          types: AIRSPACE_TYPES_QUERY,
          limit: '700',
        });
        const res = await fetch(`${API_BASE}/api/v1/airspace/viewport?${params.toString()}`);
        if (!res.ok) throw new Error(`airspace ${res.status}`);
        const data = (
          (await res.json()) as {
            data: GeoJSON.FeatureCollection & { count?: number };
          }
        ).data;
        if (seq !== airspaceSeq) return;
        setAirspaceMapData(data);
        setAirspaceCount(data.count ?? data.features.length);
        setAirspaceStatus('ready');
      } catch {
        if (seq !== airspaceSeq) return;
        setAirspaceMapData(EMPTY_FEATURES);
        setAirspaceCount(0);
        setAirspaceStatus('error');
      }
    };

    const scheduleAirspaceLoad = () => {
      if (airspaceTimer) clearTimeout(airspaceTimer);
      airspaceTimer = setTimeout(() => void loadAirspaces(), 180);
    };
    applyAirspaceRef.current = () => {
      setAirspaceVisibility();
      scheduleAirspaceLoad();
    };

    const loadTrail = async (flight: FlightSample) => {
      // Seed the buffer with whatever history the DB has; tick() extends it live.
      // Fall back to the marker's current position so a brand-new flight (no DB
      // history yet) still starts a trail instead of showing nothing.
      try {
        const params = new URLSearchParams({ limit: '2000' });
        if (flight.flightId.startsWith('adsb:')) {
          if (flight.callsign) params.set('callsign', flight.callsign);
          params.set('at', flight.ts);
        }
        const res = await fetch(
          `${API_BASE}/api/v1/flights/id/${encodeURIComponent(flight.flightId)}/track?${params}`,
        );
        const points = res.ok
          ? (
              (await res.json()) as {
                data: { points: { ts: string; lat: number | null; lon: number | null }[] };
              }
            ).data.points
          : [];
        if (selectedId !== flight.flightId) return;
        const live = client.store.get(flight.flightId) ?? flight;
        trailCoords = contiguousTrailToAnchor(points, live);
      } catch {
        if (selectedId !== flight.flightId) return;
        trailCoords = [];
      }
      if (trailCoords.length === 0) {
        const r = rendered.get(flight.flightId);
        if (r) trailCoords = [[r.lon, r.lat]];
      }
      trailLast = trailCoords.length ? (trailCoords[trailCoords.length - 1] ?? null) : null;
      renderTrail();
    };

    const clearTrail = () => {
      trailCoords = [];
      trailLast = null;
      const trail = map.getSource('trail') as maplibregl.GeoJSONSource | undefined;
      if (trail) trail.setData({ type: 'FeatureCollection', features: [] });
    };

    const setRouteData = (r: RouteInfo | null) => {
      const line = map.getSource('route') as maplibregl.GeoJSONSource | undefined;
      const ends = map.getSource('route-ends') as maplibregl.GeoJSONSource | undefined;
      if (!line || !ends) return;
      if (!r) {
        line.setData({ type: 'FeatureCollection', features: [] });
        ends.setData({ type: 'FeatureCollection', features: [] });
        return;
      }
      const coords = greatCircle(
        [r.origin.lon, r.origin.lat],
        [r.destination.lon, r.destination.lat],
      );
      line.setData({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        properties: {},
      });
      ends.setData({
        type: 'FeatureCollection',
        features: [r.origin, r.destination].map((a) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [a.lon, a.lat] },
          properties: { iata: a.iata },
        })),
      });
    };

    const loadRoute = async (flight: FlightSample) => {
      try {
        const params = new URLSearchParams({
          flightId: flight.flightId,
          icao24: flight.icao24,
          date: flight.ts.slice(0, 10),
          lat: String(flight.lat),
          lon: String(flight.lon),
          onGround: String(flight.onGround),
          ts: flight.ts,
        });
        if (flight.heading != null) params.set('headingDeg', String(flight.heading));
        const res = await fetch(
          `${API_BASE}/api/v1/flights/route/${encodeURIComponent(flight.callsign ?? flight.icao24)}?${params}`,
        );
        if (!res.ok) return;
        const r = ((await res.json()) as { data: { route: RouteInfo | null } }).data.route;
        if (selectedId !== flight.flightId) return;
        setRoute(r);
        setRouteData(r);
      } catch {
        /* no route */
      }
    };

    const select = (id: string | null) => {
      selectedId = id;
      liveTrailsDirty = true;
      renderLiveTrails(true);
      if (id) {
        airportDetailSeqRef.current += 1;
        setSelAirport(null);
        setSelectedAirportStatus('idle');
        const s = client.store.get(id);
        if (s) void loadTrail(s);
        setSel(s ? toSel(s) : null);
        if (s) void seedLiveTrailHistory([s]);
        setRoute(null);
        setRouteData(null);
        if (s?.callsign) void loadRoute(s);
      } else {
        stopAmbientAudio();
        clearTrail();
        setRouteData(null);
        setSel(null);
        setRoute(null);
      }
    };
    selectRef.current = select;

    const selectAirport = async (id: string) => {
      stopAmbientAudio();
      const seq = ++airportDetailSeqRef.current;
      selectedId = null;
      liveTrailsDirty = true;
      renderLiveTrails(true);
      clearTrail();
      setRouteData(null);
      setSel(null);
      setRoute(null);
      setSelAirport(null);
      setSelectedAirportStatus('loading');
      try {
        const res = await fetch(`${API_BASE}/api/v1/airports/id/${encodeURIComponent(id)}`);
        if (!res.ok) throw new Error(`airport detail ${res.status}`);
        const data = ((await res.json()) as { data: { airport: AirportDetail } }).data.airport;
        if (seq !== airportDetailSeqRef.current) return;
        setSelAirport(data);
        setSelectedAirportStatus('ready');
      } catch {
        if (seq !== airportDetailSeqRef.current) return;
        setSelAirport(null);
        setSelectedAirportStatus('error');
      }
    };

    // ── Search → focus: fly to a searched aircraft and select it, instead of
    // opening its detail page. Live hits are selected in place; a hit that
    // isn't in our local feed (e.g. resolved live from adsb.lol) is injected as
    // a store entry so the existing card/animation machinery renders it.
    const focusTarget = (tgt: FocusTarget) => {
      const flyTo = (lon: number, lat: number) =>
        map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 7), duration: 1200 });
      let f = client.store.get(tgt.flightId);
      if (!f && tgt.icao24) f = client.store.list().find((x) => x.icao24 === tgt.icao24);
      if (f) {
        const r = rendered.get(f.flightId);
        flyTo(r?.lon ?? f.lon, r?.lat ?? f.lat);
        select(f.flightId);
        return;
      }
      if (tgt.lat != null && tgt.lon != null) {
        client.store.applySnapshotState({
          flightId: tgt.flightId,
          icao24: tgt.icao24 ?? tgt.flightId,
          callsign: tgt.callsign,
          lat: tgt.lat,
          lon: tgt.lon,
          altFt: null,
          gsKt: null,
          headingDeg: null,
          category: null,
          lastTs: new Date().toISOString(),
        });
        flyTo(tgt.lon, tgt.lat);
        select(tgt.flightId);
      }
    };
    const unregisterFocus = registerMapFocus(focusTarget);
    const pendingFocus = readFocusFromUrl(window.location.search);

    // ── Geolocation: center on the user's region (with permission). An explicit
    // search focus always wins over auto-centering.
    let userLoc: [number, number] | null = null;
    let meMarker: maplibregl.Marker | null = null;
    const showMe = (lon: number, lat: number) => {
      if (!meMarker) {
        const el = document.createElement('div');
        el.style.cssText =
          'width:14px;height:14px;border-radius:9999px;background:#38bdf8;border:2px solid #fff;box-shadow:0 0 0 4px rgba(56,189,248,0.25);';
        meMarker = new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(map);
      } else meMarker.setLngLat([lon, lat]);
    };
    const locate = (recenter: boolean) => {
      if (typeof navigator === 'undefined' || !navigator.geolocation) return;
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          userLoc = [pos.coords.longitude, pos.coords.latitude];
          showMe(userLoc[0], userLoc[1]);
          if (recenter && map.loaded()) map.flyTo({ center: userLoc, zoom: 8, duration: 1200 });
        },
        () => {
          /* permission denied / unavailable — keep the default view */
        },
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 300_000 },
      );
    };
    locateRef.current = () => locate(true);
    if (!pendingFocus) locate(true);

    map.on('load', () => {
      if (pendingFocus) focusTarget(pendingFocus);
      else if (userLoc) map.flyTo({ center: userLoc, zoom: 8, duration: 1200 });
    });

    const addWorldGeo = async () => {
      if (map.getSource('world')) return;
      try {
        const geo = await fetch(WORLD_GEOJSON_URL).then((r) => r.json());
        if (map.getSource('world')) return;
        const c = currentDark ? WORLD_COLORS.dark : WORLD_COLORS.light;
        map.addSource('grid', { type: 'geojson', data: graticule(10) });
        map.addLayer({
          id: 'grid',
          type: 'line',
          source: 'grid',
          paint: { 'line-color': c.grid, 'line-width': 0.5 },
        });
        map.addSource('world', { type: 'geojson', data: geo });
        map.addLayer({
          id: 'world-fill',
          type: 'fill',
          source: 'world',
          paint: { 'fill-color': c.fill, 'fill-opacity': 0.9 },
        });
        map.addLayer({
          id: 'world-line',
          type: 'line',
          source: 'world',
          paint: { 'line-color': c.line, 'line-width': 0.7 },
        });
      } catch {
        /* geography best-effort */
      }
    };

    // Overlays are re-added on every style load (setStyle wipes custom layers).
    const ensureLayers = async () => {
      if (!usingRemote) await addWorldGeo();

      if (!map.hasImage('plane')) {
        map.addImage('plane', makePlaneImage(64), { sdf: true, pixelRatio: 2 });
        map.addImage('prop', makePropImage(64), { sdf: true, pixelRatio: 2 });
        map.addImage('helo', makeHeloImage(64), { sdf: true, pixelRatio: 2 });
      }
      if (!map.hasImage('airport')) {
        map.addImage('airport', makeAirportImage(64), { sdf: true, pixelRatio: 2 });
      }
      for (const kind of ['storm', 'rain', 'wind', 'snow', 'fog', 'generic'] as const) {
        const imageId = `weather-${kind}`;
        if (!map.hasImage(imageId)) {
          map.addImage(imageId, makeWeatherImage(kind, 64), { sdf: true, pixelRatio: 2 });
        }
      }

      if (!map.getSource('airspaces')) {
        map.addSource('airspaces', { type: 'geojson', data: EMPTY_FEATURES });
        map.addLayer({
          id: 'airspace-fill',
          type: 'fill',
          source: 'airspaces',
          layout: { visibility: airspaceEnabledRef.current ? 'visible' : 'none' },
          paint: {
            'fill-color': AIRSPACE_FILL_COLOR,
            'fill-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.05, 8, 0.13, 11, 0.2],
          },
        });
        map.addLayer({
          id: 'airspace-line',
          type: 'line',
          source: 'airspaces',
          layout: { visibility: airspaceEnabledRef.current ? 'visible' : 'none' },
          paint: {
            'line-color': AIRSPACE_LINE_COLOR,
            'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.7, 9, 1.4],
            'line-opacity': 0.9,
          },
        });
        map.addLayer({
          id: 'airspace-label',
          type: 'symbol',
          source: 'airspaces',
          minzoom: 7,
          layout: {
            visibility: airspaceEnabledRef.current ? 'visible' : 'none',
            'text-field': ['concat', ['get', 'name'], '\n', ['get', 'type']],
            'text-size': ['interpolate', ['linear'], ['zoom'], 7, 10, 10, 12],
            'text-allow-overlap': false,
            'text-padding': 8,
          },
          paint: {
            'text-color': '#dbeafe',
            'text-halo-color': '#050912',
            'text-halo-width': 1.2,
            'text-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0, 8, 0.86],
          },
        });
      }

      if (!map.getSource('weather')) {
        const visibility = weatherEnabledRef.current ? 'visible' : 'none';
        map.addSource('weather', { type: 'geojson', data: EMPTY_FEATURES });
        map.addLayer({
          id: 'weather-glow',
          type: 'circle',
          source: 'weather',
          layout: { visibility },
          paint: {
            'circle-radius': ['case', ['==', ['get', 'kind'], 'storm'], 24, 18],
            'circle-color': WEATHER_COLOR,
            'circle-blur': 0.7,
            'circle-opacity': 0.32,
          },
        });
        map.addLayer({
          id: 'weather-core',
          type: 'circle',
          source: 'weather',
          layout: { visibility },
          paint: {
            'circle-radius': [
              'match',
              ['get', 'severity'],
              'severe',
              15,
              'high',
              14,
              'moderate',
              13,
              12,
            ],
            'circle-color': WEATHER_COLOR,
            'circle-opacity': 0.96,
            'circle-stroke-color': '#f8fafc',
            'circle-stroke-width': 1.5,
            'circle-stroke-opacity': 0.92,
          },
        });
        map.addLayer({
          id: 'weather-symbol',
          type: 'symbol',
          source: 'weather',
          layout: {
            visibility,
            'icon-image': WEATHER_ICON,
            'icon-size': ['interpolate', ['linear'], ['zoom'], 2, 0.48, 7, 0.6, 11, 0.68],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
          },
          paint: {
            'icon-color': '#07111f',
            'icon-opacity': 1,
          },
        });
        map.addLayer({
          id: 'weather-label',
          type: 'symbol',
          source: 'weather',
          minzoom: 4.5,
          layout: {
            visibility,
            'text-field': ['get', 'label'],
            'text-size': 10,
            'text-offset': [0, 1.65],
            'text-anchor': 'top',
            'text-allow-overlap': true,
            'text-ignore-placement': true,
            'text-padding': 5,
          },
          paint: {
            'text-color': '#f8fafc',
            'text-halo-color': '#07111f',
            'text-halo-width': 1.2,
          },
        });
      }

      if (!map.getSource('airports')) {
        map.addSource('airports', { type: 'geojson', data: EMPTY_FEATURES });
        map.addLayer({
          id: 'airports',
          type: 'symbol',
          source: 'airports',
          layout: {
            visibility: airportsEnabledRef.current ? 'visible' : 'none',
            'icon-image': 'airport',
            'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 0.24, 7, 0.38, 11, 0.56],
            'icon-allow-overlap': false,
            'icon-ignore-placement': false,
          },
          paint: {
            'icon-color': AIRPORT_COLOR,
            'icon-halo-color': '#050912',
            'icon-halo-width': 1.2,
            'icon-opacity': ['case', ['==', ['get', 'scheduledService'], true], 0.95, 0.72],
          },
        });
        map.addLayer({
          id: 'airport-labels',
          type: 'symbol',
          source: 'airports',
          minzoom: 6.3,
          layout: {
            visibility: airportsEnabledRef.current ? 'visible' : 'none',
            'text-field': ['coalesce', ['get', 'iata'], ['get', 'icao']],
            'text-size': ['interpolate', ['linear'], ['zoom'], 6, 9, 10, 11],
            'text-offset': [0, 1.3],
            'text-anchor': 'top',
            'text-allow-overlap': false,
            'text-ignore-placement': false,
            'text-padding': 4,
          },
          paint: {
            'text-color': '#dbeafe',
            'text-halo-color': '#050912',
            'text-halo-width': 1.1,
            'text-opacity': ['interpolate', ['linear'], ['zoom'], 6.3, 0, 7.2, 0.9],
          },
        });
      }

      if (!map.getSource('live-trails')) {
        map.addSource('live-trails', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        map.addLayer({
          id: 'live-trails',
          type: 'line',
          source: 'live-trails',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': [
              'case',
              ['==', ['get', 'selected'], 1],
              '#7dd3fc',
              [
                'match',
                ['get', 'quality'],
                'live',
                '#38bdf8',
                'delayed',
                '#67e8f9',
                'stale',
                '#94a3b8',
                'signal_lost',
                '#64748b',
                '#38bdf8',
              ],
            ],
            'line-width': ['case', ['==', ['get', 'selected'], 1], 2.2, 1.1],
            'line-opacity': [
              'case',
              ['==', ['get', 'selected'], 1],
              0.65,
              [
                'match',
                ['get', 'quality'],
                'live',
                0.46,
                'delayed',
                0.34,
                'stale',
                0.22,
                'signal_lost',
                0.12,
                0.36,
              ],
            ],
          },
        });
        renderLiveTrails(true);
      }

      // Planned route (origin → destination great circle), dashed + muted.
      if (!map.getSource('route')) {
        map.addSource('route', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        map.addLayer({
          id: 'route-line',
          type: 'line',
          source: 'route',
          layout: { 'line-cap': 'round' },
          paint: {
            'line-color': '#64748b',
            'line-width': 1.4,
            'line-dasharray': [2, 2],
            'line-opacity': 0.8,
          },
        });
        map.addSource('route-ends', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        map.addLayer({
          id: 'route-ends',
          type: 'circle',
          source: 'route-ends',
          paint: {
            'circle-radius': 4,
            'circle-color': '#0b1020',
            'circle-stroke-color': '#94a3b8',
            'circle-stroke-width': 1.5,
          },
        });
      }

      if (!map.getSource('trail')) {
        map.addSource('trail', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        map.addLayer({
          id: 'trail-glow',
          type: 'line',
          source: 'trail',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#38bdf8', 'line-width': 7, 'line-blur': 6, 'line-opacity': 0.35 },
        });
        map.addLayer({
          id: 'trail-line',
          type: 'line',
          source: 'trail',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#7dd3fc', 'line-width': 1.6, 'line-opacity': 0.9 },
        });
      }

      if (!map.getSource('selected')) {
        map.addSource('selected', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        map.addLayer({
          id: 'sel-ring',
          type: 'circle',
          source: 'selected',
          paint: {
            'circle-radius': 16,
            'circle-color': '#38bdf8',
            'circle-opacity': 0.2,
            'circle-stroke-color': '#7dd3fc',
            'circle-stroke-width': 1.5,
          },
        });
      }

      if (!map.getSource('flights')) {
        map.addSource('flights', { type: 'geojson', data: featureCollection() });
        map.addLayer({
          id: 'flights',
          type: 'symbol',
          source: 'flights',
          layout: {
            'icon-image': ['match', ['get', 'cat'], 'light', 'prop', 'helo', 'helo', 'plane'],
            'icon-rotate': ['get', 'heading'],
            'icon-rotation-alignment': 'map',
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            'icon-size': ICON_SIZE,
          },
          paint: {
            'icon-color': ALT_COLOR,
            'icon-halo-color': '#050912',
            'icon-halo-width': 1.1,
            'icon-opacity': [
              'case',
              ['==', ['get', 'onGround'], 1],
              0.65,
              [
                'match',
                ['get', 'quality'],
                'live',
                1,
                'delayed',
                0.78,
                'stale',
                0.48,
                'signal_lost',
                0.22,
                1,
              ],
            ],
          },
        });
      }
      applyFilter();
    };

    // Apply the current altitude/airline filter to the flights layer.
    const applyFilter = () => {
      if (!map.getLayer('flights')) return;
      map.setFilter('flights', buildFilter(filterRef.current));
    };
    applyFilterRef.current = applyFilter;

    // Connect the realtime feed + start the animation loop (once).
    const startFeed = () => {
      if (started) return;
      started = true;
      void client.connect().then(sendViewport);
      airportInterval = setInterval(scheduleAirportLoad, AIRPORT_POLL_MS);
      weatherInterval = setInterval(scheduleWeatherLoad, WEATHER_POLL_MS);
      viewportLiveInterval = setInterval(scheduleViewportLive, VIEWPORT_LIVE_POLL_MS);
      raf = requestAnimationFrame(tick);
    };

    map.on('style.load', () => {
      void ensureLayers().then(() => {
        setAirportVisibility();
        setAirspaceVisibility();
        setWeatherVisibility();
        // Theme-swap reload: overlays + their data were carried across, so just
        // re-apply layers/visibility — don't reconnect the feed or refetch.
        if (carrySwap) {
          carrySwap = false;
          return;
        }
        scheduleAirportLoad();
        scheduleAirspaceLoad();
        scheduleWeatherLoad(0);
        startFeed();
      });
    });

    // Interaction handlers — attached once; bound by layer id they survive setStyle.
    map.on('click', 'flights', (e) => {
      const properties = e.features?.[0]?.properties;
      const id = properties?.flightId as string | undefined;
      if (id && properties) {
        toggleAmbientAudio(`aircraft:${id}`, aircraftSoundPath(properties.cat));
        select(id);
      }
    });
    map.on('click', 'airports', (e) => {
      if (map.queryRenderedFeatures(e.point, { layers: ['flights'] }).length > 0) return;
      const id = e.features?.[0]?.properties?.id as string | undefined;
      if (id) void selectAirport(id);
    });
    map.on('click', 'weather-core', (e) => {
      if (map.queryRenderedFeatures(e.point, { layers: ['flights'] }).length > 0) return;
      const feature = e.features?.[0];
      if (!feature?.properties) return;
      toggleWeatherAudio(feature.properties);
      weatherPopup?.remove();
      weatherPopup = new maplibregl.Popup({
        className: 'flt-popup',
        closeButton: false,
        offset: 16,
      })
        .setLngLat(e.lngLat)
        .setDOMContent(weatherPopupNode(feature.properties))
        .addTo(map);
    });
    map.on('click', (e) => {
      const hits = map.queryRenderedFeatures(e.point, {
        layers: ['flights', 'airports', 'weather-core'],
      });
      if (hits.length === 0) {
        stopAmbientAudio();
        weatherPopup?.remove();
        weatherPopup = null;
        airportDetailSeqRef.current += 1;
        select(null);
        setSelAirport(null);
        setSelectedAirportStatus('idle');
      }
    });
    map.on('mouseenter', 'flights', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'flights', () => {
      map.getCanvas().style.cursor = '';
    });
    map.on('mouseenter', 'airports', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'airports', () => {
      map.getCanvas().style.cursor = '';
    });
    map.on('mouseenter', 'weather-core', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'weather-core', () => {
      map.getCanvas().style.cursor = '';
    });

    // A basemap tile loading proves the remote style isn't blocked.
    map.on('data', (e) => {
      const ev = e as unknown as { dataType?: string; tile?: unknown; sourceId?: string };
      if (ev.dataType === 'source' && ev.tile && ev.sourceId && !OURS.has(ev.sourceId)) {
        remoteTileOk = true;
      }
    });

    // Remote basemap blocked/slow (ad-blockers) → fall back to the bundled dark
    // style + first-party geography so the map still renders (no black screen).
    const fallbackTimer = setTimeout(() => {
      if (usingRemote && !remoteTileOk) {
        console.warn('remote basemap unavailable — using bundled offline map');
        usingRemote = false;
        map.setStyle(baseStyleFor(currentDark));
      }
    }, 4500);

    map.on('move', () => {
      scheduleViewportLive(420);
    });
    map.on('moveend', () => {
      sendViewport();
      scheduleViewportLive(0);
      scheduleAirportLoad();
      scheduleAirspaceLoad();
      scheduleWeatherLoad();
    });
    const unsub = client.store.subscribe(() => {
      setCount(client.store.size);
      if (selectedId) {
        const s = client.store.get(selectedId);
        if (s) setSel(toSel(s));
        else select(null);
      }
    });

    return () => {
      clearTimeout(fallbackTimer);
      airportDetailSeqRef.current += 1;
      if (airportTimer) clearTimeout(airportTimer);
      if (airportInterval) clearInterval(airportInterval);
      if (airspaceTimer) clearTimeout(airspaceTimer);
      if (weatherTimer) clearTimeout(weatherTimer);
      if (weatherInterval) clearInterval(weatherInterval);
      weatherAbort?.abort();
      stopAmbientAudio();
      weatherPopup?.remove();
      if (viewportLiveTimer) clearTimeout(viewportLiveTimer);
      if (viewportLiveInterval) clearInterval(viewportLiveInterval);
      viewportLiveAbort?.abort();
      cancelAnimationFrame(raf);
      ro.disconnect();
      themeObserver.disconnect();
      unsub();
      offStatus();
      unregisterFocus();
      meMarker?.remove();
      client.close();
      map.remove();
    };
  }, []);

  // Aircraft photo for the selected flight (proxied via our API — Planespotters
  // requires a contact User-Agent the browser can't set).
  useEffect(() => {
    const hex = sel?.icao24;
    if (!hex) {
      setPhoto(null);
      return;
    }
    let cancelled = false;
    setPhoto(null);
    fetch(`${API_BASE}/api/v1/aircraft-photo/${hex}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setPhoto((d?.data?.photo?.thumb as string | undefined) ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [sel?.icao24]);

  useEffect(() => {
    selectedAirspaceRef.current = sel;
  }, [sel]);

  const selectedAirspaceKey = sel
    ? [
        sel.flightId,
        sel.lat.toFixed(2),
        sel.lon.toFixed(2),
        sel.altFt != null ? Math.round(sel.altFt / 1000) : 'na',
      ].join(':')
    : '';

  useEffect(() => {
    const selected = selectedAirspaceRef.current;
    if (!selectedAirspaceKey || !selected) {
      setSelectedAirspaces([]);
      setSelectedAirspaceStatus('idle');
      return;
    }
    let cancelled = false;
    setSelectedAirspaceStatus('loading');
    const params = new URLSearchParams({
      lat: String(selected.lat),
      lon: String(selected.lon),
      ...(selected.altFt != null ? { alt: String(selected.altFt) } : {}),
    });
    fetch(`${API_BASE}/api/v1/airspace/current?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled) return;
        const matches = (body?.data?.matches as AirspaceSummary[] | undefined) ?? [];
        setSelectedAirspaces(matches);
        setSelectedAirspaceStatus('ready');
      })
      .catch(() => {
        if (!cancelled) {
          setSelectedAirspaces([]);
          setSelectedAirspaceStatus('error');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedAirspaceKey]);

  if (failed) {
    return (
      <div className="fixed inset-x-0 bottom-0 top-14 grid place-items-center p-6">
        <ErrorState
          title={t('map.webglTitle')}
          description={t('map.webglBody')}
          onRetry={() => window.location.reload()}
        />
      </div>
    );
  }

  const statusDot =
    connectionStatus === 'connected'
      ? 'bg-success'
      : connectionStatus === 'reconnecting' || connectionStatus === 'connecting'
        ? 'bg-warning'
        : 'bg-muted-foreground';

  return (
    <div className="fixed inset-x-0 bottom-0 top-14">
      {/* Explicit size-full — maplibre forces `position: relative` on its
          container, which would neutralise `absolute inset-0` and collapse it. */}
      <div ref={containerRef} className="size-full" />

      <div className="absolute left-3 right-3 top-3 z-10 flex flex-col gap-2 sm:left-4 sm:right-auto sm:top-4">
        <div className="flex items-start gap-2">
          <div className="flex h-9 items-center gap-2 rounded-md border border-border bg-card/85 px-3 text-sm font-medium shadow-soft-md backdrop-blur-md">
            <span className="relative flex size-2">
              {connectionStatus === 'connected' && (
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-75" />
              )}
              <span className={cn('relative inline-flex size-2 rounded-full', statusDot)} />
            </span>
            <span className="tabular-nums">{count.toLocaleString()}</span>
            <span className="text-muted-foreground">{t('common.live')}</span>
          </div>
          <SearchBox className="w-56 sm:w-72" />
        </div>

        {/* Filters: altitude band + airline prefix */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-md border border-border bg-card/85 p-0.5 shadow-soft-md backdrop-blur-md">
            {(['all', 'low', 'mid', 'high'] as const).map((b) => (
              <button
                key={b}
                type="button"
                onClick={() => changeBand(b)}
                aria-pressed={band === b}
                className={cn(
                  'rounded-[5px] px-2 py-1 text-xs font-medium transition-colors',
                  band === b
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t(`map.filter.${b}`)}
              </button>
            ))}
          </div>
          <input
            value={airline}
            onChange={(e) => changeAirline(e.target.value)}
            placeholder={t('map.filter.airline')}
            className="h-8 w-40 rounded-md border border-border bg-card/85 px-2.5 text-xs shadow-soft-md backdrop-blur-md outline-none placeholder:text-muted-foreground focus-visible:border-ring"
          />
          <div className="flex basis-full flex-wrap items-center gap-2 sm:basis-auto">
            <button
              type="button"
              onClick={toggleAirports}
              aria-pressed={airportsEnabled}
              className={cn(
                'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-card/85 px-2.5 text-xs font-medium shadow-soft-md backdrop-blur-md transition-colors',
                airportsEnabled ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <TowerControl className="size-3.5" />
              {t('map.airports')}
              {airportsEnabled && (
                <span className="tabular-nums text-muted-foreground">
                  {airportStatus === 'loading'
                    ? '...'
                    : airportStatus === 'error'
                      ? t('map.airports.error')
                      : airportCount.toLocaleString()}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={toggleWeather}
              aria-pressed={weatherEnabled}
              className={cn(
                'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-card/85 px-2.5 text-xs font-medium shadow-soft-md backdrop-blur-md transition-colors',
                weatherEnabled ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <CloudSun
                className={cn('size-3.5', weatherStatus === 'loading' && 'animate-pulse')}
              />
              {t('map.weather')}
              {weatherEnabled && (
                <span className="tabular-nums text-muted-foreground">
                  {weatherStatus === 'loading'
                    ? '...'
                    : weatherStatus === 'error'
                      ? t('map.weather.error')
                      : weatherCount.toLocaleString()}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={toggleAirspace}
              aria-pressed={airspaceEnabled}
              className={cn(
                'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-card/85 px-2.5 text-xs font-medium shadow-soft-md backdrop-blur-md transition-colors',
                airspaceEnabled ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Layers className="size-3.5" />
              {t('map.airspace')}
              {airspaceEnabled && (
                <span className="tabular-nums text-muted-foreground">
                  {airspaceStatus === 'loading'
                    ? '...'
                    : airspaceStatus === 'zoom'
                      ? t('map.airspace.zoom')
                      : airspaceStatus === 'error'
                        ? t('map.airspace.error')
                        : airspaceCount.toLocaleString()}
                </span>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Locate me — center on the user's region (asks for location permission) */}
      <button
        type="button"
        aria-label={t('map.locate')}
        title={t('map.locate')}
        onClick={() => locateRef.current()}
        className="absolute bottom-16 right-3 z-10 inline-flex size-10 items-center justify-center rounded-md border border-border bg-card/85 text-muted-foreground shadow-soft-md backdrop-blur-md transition-colors hover:text-foreground sm:bottom-14"
      >
        <LocateFixed className="size-5" />
      </button>

      {/* Altitude legend */}
      <div className="absolute bottom-4 right-3 z-10 hidden items-center gap-2 rounded-md border border-border bg-card/85 px-3 py-2 text-xs shadow-soft-md backdrop-blur-md sm:flex">
        <span className="text-muted-foreground">{t('common.low')}</span>
        <span
          className="h-1.5 w-24 rounded-full"
          style={{ background: 'linear-gradient(90deg,#22c55e,#eab308,#fb923c,#38bdf8,#e2e8f0)' }}
        />
        <span className="text-muted-foreground">{t('common.high')}</span>
      </div>

      {/* Selected flight card — stays on the map */}
      {sel && (
        <div className="absolute inset-x-3 bottom-3 z-20 sm:inset-x-auto sm:left-4 sm:bottom-4 sm:w-80">
          <div className="overflow-hidden rounded-xl border border-border bg-card/95 shadow-soft-lg backdrop-blur-md">
            {photo ? (
              <img src={photo} alt={sel.callsign} className="h-36 w-full object-cover" />
            ) : (
              <div className="flex h-20 items-center justify-center bg-muted text-muted-foreground">
                <Plane className="size-6" />
              </div>
            )}
            <div className="p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-lg font-semibold leading-tight">{sel.callsign}</div>
                  <div className="text-xs text-muted-foreground">
                    {sel.icao24.toUpperCase()} · {t(`map.cat.${sel.category}`)}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[10px] font-medium uppercase',
                        qualityChipClass(sel.qualityState),
                      )}
                    >
                      {t(`map.signal.${sel.qualityState}`)}
                    </span>
                    {sourceLabel(sel.source, sel.positionSource, sel.isMlat ?? false) !== '—' && (
                      <span className="rounded bg-background/70 px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                        {sourceLabel(sel.source, sel.positionSource, sel.isMlat ?? false)}
                      </span>
                    )}
                    {sel.qualityScore != null && (
                      <span className="rounded bg-background/70 px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                        Q {formatPercent(sel.qualityScore)}
                      </span>
                    )}
                    <span className="rounded bg-background/70 px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                      {fmtAgeMs(sel.ageMs ?? Date.now() - sel.tsMs)}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  aria-label={t('common.close')}
                  onClick={() => selectRef.current(null)}
                  className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <X className="size-4" />
                </button>
              </div>

              {route && (
                <div className="mt-3 rounded-md bg-muted/50 px-3 py-2">
                  <div className="flex items-center justify-center gap-3 text-sm">
                    <span className="font-semibold" title={route.origin.name}>
                      {route.origin.iata || '—'}
                    </span>
                    <span className="flex-1 border-t border-dashed border-muted-foreground/40" />
                    <Plane className="size-3.5 rotate-90 text-accent-bright" />
                    <span className="flex-1 border-t border-dashed border-muted-foreground/40" />
                    <span className="font-semibold" title={route.destination.name}>
                      {route.destination.iata || '—'}
                    </span>
                  </div>
                  <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
                    <span className="max-w-[45%] truncate">
                      {route.origin.city ?? route.origin.name}
                    </span>
                    <span className="max-w-[45%] truncate text-right">
                      {route.destination.city ?? route.destination.name}
                    </span>
                  </div>
                </div>
              )}

              <AirspaceSummaryBlock
                airspaces={selectedAirspaces}
                status={selectedAirspaceStatus}
                label={t('map.airspace')}
              />

              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                <Metric
                  label={t('map.altitude')}
                  value={sel.onGround ? t('map.ground') : fmtFt(sel.altFt)}
                />
                <Metric
                  label={t('map.speed')}
                  value={sel.gsKt != null ? `${Math.round(sel.gsKt)} kt` : '—'}
                />
                <Metric
                  label={t('map.heading')}
                  value={sel.heading != null ? `${Math.round(sel.heading)}°` : '—'}
                />
                <Metric label={t('map.geoAltitude')} value={fmtFt(sel.geoAltitudeFt)} />
                <Metric label={t('map.vertical')} value={fmtVRate(sel.verticalRateFpm)} />
                <Metric label={t('map.squawk')} value={sel.squawk ?? '—'} />
              </div>

              <Link
                href={`/flights/id/${encodeURIComponent(sel.flightId)}`}
                onClick={() => cacheSelectedLiveDetail(sel)}
                className="mt-4 flex h-9 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                {t('common.details')}
              </Link>
            </div>
          </div>
        </div>
      )}

      {!sel && selectedAirportStatus === 'loading' && (
        <div className="absolute inset-x-3 bottom-3 z-20 sm:inset-x-auto sm:left-4 sm:bottom-4 sm:w-80">
          <div className="overflow-hidden rounded-xl border border-border bg-card/95 shadow-soft-lg backdrop-blur-md">
            <div className="flex h-20 items-center justify-center bg-muted text-muted-foreground">
              <TowerControl className="size-6" />
            </div>
            <div className="p-4">
              <div className="h-5 w-40 animate-pulse rounded bg-muted" />
              <div className="mt-2 h-3 w-56 animate-pulse rounded bg-muted" />
            </div>
          </div>
        </div>
      )}

      {!sel && selectedAirportStatus === 'error' && (
        <div className="absolute inset-x-3 bottom-3 z-20 sm:inset-x-auto sm:left-4 sm:bottom-4 sm:w-80">
          <div className="rounded-xl border border-border bg-card/95 p-4 shadow-soft-lg backdrop-blur-md">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-semibold">{t('map.airports.error')}</div>
                <div className="mt-1 text-sm text-muted-foreground">{t('common.retry')}</div>
              </div>
              <button
                type="button"
                aria-label={t('common.close')}
                onClick={() => {
                  setSelectedAirportStatus('idle');
                  setSelAirport(null);
                }}
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {!sel && selAirport && (
        <div className="absolute inset-x-3 bottom-3 z-20 sm:inset-x-auto sm:left-4 sm:bottom-4 sm:w-80">
          <div className="overflow-hidden rounded-xl border border-border bg-card/95 shadow-soft-lg backdrop-blur-md">
            {selAirport.photo?.url ? (
              <img
                src={selAirport.photo.url}
                alt={selAirport.name}
                referrerPolicy="no-referrer"
                className="h-36 w-full object-cover"
              />
            ) : (
              <div className="flex h-20 items-center justify-center bg-muted text-muted-foreground">
                <TowerControl className="size-6" />
              </div>
            )}
            <div className="p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-lg font-semibold leading-tight">
                    {airportCode(selAirport)}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">{selAirport.name}</div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    {[selAirport.city, selAirport.country].filter(Boolean).join(', ') || '—'}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <span className="rounded bg-background/70 px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                      {airportTypeLabel(selAirport.type)}
                    </span>
                    <span className="rounded bg-background/70 px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                      {selAirport.scheduledService
                        ? t('map.airport.scheduled')
                        : t('map.airport.unscheduled')}
                    </span>
                    {selAirport.timezone && (
                      <span className="rounded bg-background/70 px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                        {selAirport.timezone}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  aria-label={t('common.close')}
                  onClick={() => {
                    airportDetailSeqRef.current += 1;
                    setSelAirport(null);
                    setSelectedAirportStatus('idle');
                  }}
                  className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <X className="size-4" />
                </button>
              </div>

              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                <Metric label={t('map.airport.code')} value={selAirport.icao} />
                <Metric label={t('map.altitude')} value={fmtFt(selAirport.elevationFt)} />
                <Metric
                  label={t('map.airport.runways')}
                  value={String(runwayCount(selAirport.runways))}
                />
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {selAirport.iata && (
                  <Link
                    href={`/airports/${selAirport.iata}`}
                    className="inline-flex h-8 items-center justify-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                  >
                    {t('common.details')}
                  </Link>
                )}
                {selAirport.homeUrl && (
                  <a
                    href={selAirport.homeUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {t('map.airport.website')}
                    <ExternalLink className="size-3" />
                  </a>
                )}
                {selAirport.wikipediaUrl && (
                  <a
                    href={selAirport.wikipediaUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {t('map.airport.wiki')}
                    <ExternalLink className="size-3" />
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function airportCode(a: AirportDetail): string {
  return a.iata ?? a.icao;
}

function airportTypeLabel(type: string | null): string {
  if (!type) return 'Airport';
  return type.replace(/_/g, ' ');
}

function runwayCount(runways: unknown): number {
  return Array.isArray(runways) ? runways.length : 0;
}

function fmtFt(ft: number | null): string {
  return ft != null ? `${Math.round(ft).toLocaleString()} ft` : '—';
}

function fmtVRate(vrate: number | null): string {
  if (vrate == null) return '—';
  const rounded = Math.round(vrate);
  return `${rounded > 0 ? '+' : ''}${rounded.toLocaleString()} fpm`;
}

function fmtAgeMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

function formatPercent(n: number): string {
  return `${Math.round(Math.max(0, Math.min(1, n)) * 100)}%`;
}

function sourceLabel(
  source: string | null,
  positionSource: string | null,
  isMlat: boolean,
): string {
  const base = (positionSource ?? source)?.trim();
  if (!base) return '—';
  const normalized = base.toUpperCase().replace(/[_-]/g, ' ');
  if (base.toLowerCase() === 'mlat') return 'MLAT';
  return isMlat ? `${normalized}/MLAT` : normalized;
}

function qualityChipClass(state: FlightQualityState): string {
  if (state === 'live') return 'bg-success/15 text-success';
  if (state === 'delayed') return 'bg-warning/15 text-warning';
  if (state === 'stale') return 'bg-warning/15 text-warning';
  return 'bg-destructive/15 text-destructive';
}

function fmtBand(a: AirspaceSummary): string {
  const lower = a.lowerFt == null || a.lowerFt <= 0 ? 'GND' : `${a.lowerFt.toLocaleString()} ft`;
  const upper = a.upperFt == null ? 'UNL' : `${a.upperFt.toLocaleString()} ft`;
  return `${lower}-${upper}`;
}

function AirspaceSummaryBlock({
  airspaces,
  status,
  label,
}: {
  airspaces: AirspaceSummary[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  label: string;
}) {
  if (status === 'idle') return null;
  const primary = airspaces[0];
  return (
    <div className="mt-3 rounded-md bg-muted/50 px-3 py-2">
      <div className="flex items-start gap-2">
        <RadioTower className="mt-0.5 size-3.5 shrink-0 text-accent-bright" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-medium uppercase text-muted-foreground">{label}</span>
            {primary && (
              <span className="text-[10px] text-muted-foreground">{fmtBand(primary)}</span>
            )}
          </div>
          <div className="mt-0.5 truncate text-sm font-medium">
            {status === 'loading'
              ? 'Loading...'
              : status === 'error'
                ? 'Unavailable'
                : primary
                  ? primary.name
                  : 'Outside controlled airspace'}
          </div>
          {primary && (
            <div className="mt-1 flex flex-wrap gap-1">
              {airspaces.slice(0, 3).map((airspace) => (
                <span
                  key={airspace.id}
                  className="rounded bg-background/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                >
                  {airspace.type}
                  {airspace.class ? ` ${airspace.class}` : ''}
                  {airspace.frequency ? ` · ${airspace.frequency}` : ''}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted/50 py-2">
      <div className="text-sm font-semibold tabular-nums">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}
