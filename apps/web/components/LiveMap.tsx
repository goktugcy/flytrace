'use client';

import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { SearchBox } from '@/components/SearchBox';
import { ErrorState } from '@/components/ui/states';
import { Plane, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { FlightSample } from '../lib/flight-store';
import { RealtimeClient } from '../lib/realtime-client';

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

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const WS_BASE = API_BASE.replace(/^http/, 'ws');
const LERP = 0.16; // per-frame easing toward the latest sample (docs/12 §12.5)

// Self-contained dark base + bundled first-party geography (public/geo/world.json)
// so the map always renders — external tile CDNs are routinely blocked by
// ad/privacy extensions. Set NEXT_PUBLIC_MAP_STYLE to opt into a tile basemap.
const REMOTE_STYLE = process.env.NEXT_PUBLIC_MAP_STYLE;
const WORLD_GEOJSON_URL = '/geo/world.json';

const DARK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#080d18' } }],
};

interface Rendered {
  lat: number;
  lon: number;
  hdg: number;
}

interface SelInfo {
  flightId: string;
  icao24: string;
  callsign: string;
  altFt: number | null;
  gsKt: number | null;
  heading: number | null;
  onGround: boolean;
}

const SIZE_MUL = [0.7, 0.85, 1.05, 1.3];

function toSel(f: FlightSample): SelInfo {
  return {
    flightId: f.flightId,
    icao24: f.icao24,
    callsign: f.callsign ?? f.icao24,
    altFt: f.altFt,
    gsKt: f.gsKt,
    heading: f.heading,
    onGround: f.onGround,
  };
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

// Aircraft size class from client-available signals (a pragmatic proxy for type).
function sizeClass(altFt: number | null, gsKt: number | null, onGround: boolean): number {
  if (onGround) return 0;
  if ((gsKt ?? 0) < 160 && (altFt ?? 0) < 10000) return 1; // light / regional
  if ((altFt ?? 0) >= 28000) return 3; // heavy / widebody cruise
  return 2; // jet
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

/** Shortest signed angular delta a→b in degrees. */
function angleDelta(a: number, b: number): number {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

export function LiveMap() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const selectRef = useRef<(id: string | null) => void>(() => {});
  const [count, setCount] = useState(0);
  const [failed, setFailed] = useState(false);
  const [sel, setSel] = useState<SelInfo | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    if (!webglAvailable()) {
      setFailed(true);
      return;
    }

    let map: maplibregl.Map;
    let darkActive = !REMOTE_STYLE;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: REMOTE_STYLE ?? DARK_STYLE,
        center: [35, 39],
        zoom: 5,
        attributionControl: false,
        maxZoom: 12,
      });
    } catch {
      setFailed(true);
      return;
    }
    map.addControl(new maplibregl.NavigationControl({ showZoom: true }), 'top-right');
    map.addControl(
      new maplibregl.AttributionControl({
        customAttribution: 'Positions © OpenSky Network · © MapLibre',
      }),
    );

    const resize = () => map.resize();
    requestAnimationFrame(resize);
    const ro = new ResizeObserver(resize);
    ro.observe(containerRef.current);

    const client = new RealtimeClient({ apiBase: API_BASE, wsBase: WS_BASE });
    const rendered = new Map<string, Rendered>();
    let raf = 0;
    let didSetup = false;
    let selectedId: string | null = null;
    let pulse = 0;

    const featureCollection = (): GeoJSON.FeatureCollection => ({
      type: 'FeatureCollection',
      features: client.store.list().map((f) => {
        const r = rendered.get(f.flightId) ?? { lat: f.lat, lon: f.lon, hdg: f.heading ?? 0 };
        const cls = sizeClass(f.altFt, f.gsKt, f.onGround);
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
          properties: {
            flightId: f.flightId,
            callsign: f.callsign ?? f.icao24,
            heading: r.hdg,
            alt: f.altFt ?? 0,
            gs: f.gsKt ?? 0,
            sizeMul: SIZE_MUL[cls],
            onGround: f.onGround ? 1 : 0,
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

    const tick = () => {
      for (const f of client.store.list()) {
        const r = rendered.get(f.flightId);
        if (!r) rendered.set(f.flightId, { lat: f.lat, lon: f.lon, hdg: f.heading ?? 0 });
        else {
          r.lat += (f.lat - r.lat) * LERP;
          r.lon += (f.lon - r.lon) * LERP;
          if (f.heading != null) r.hdg += angleDelta(r.hdg, f.heading) * LERP;
        }
      }
      for (const id of rendered.keys()) if (!client.store.get(id)) rendered.delete(id);

      const src = map.getSource('flights') as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(featureCollection());

      const selSrc = map.getSource('selected') as maplibregl.GeoJSONSource | undefined;
      if (selSrc) selSrc.setData(selectedFeature());
      if (selectedId && map.getLayer('sel-ring')) {
        pulse += 0.05;
        map.setPaintProperty('sel-ring', 'circle-radius', 16 + Math.sin(pulse) * 4);
        map.setPaintProperty('sel-ring', 'circle-opacity', 0.18 + (Math.sin(pulse) + 1) * 0.06);
      }
      raf = requestAnimationFrame(tick);
    };

    const sendViewport = () => {
      const b = map.getBounds();
      client.setViewport([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
    };

    const loadTrail = async (flightId: string) => {
      try {
        const res = await fetch(`${API_BASE}/api/v1/flights/id/${flightId}/track?limit=2000`);
        if (!res.ok) return;
        const points = ((await res.json()) as { data: { points: { lat: number; lon: number }[] } })
          .data.points;
        const coords = points
          .filter((p) => p.lat != null && p.lon != null)
          .map((p) => [p.lon, p.lat] as [number, number]);
        const trail = map.getSource('trail') as maplibregl.GeoJSONSource | undefined;
        if (trail)
          trail.setData({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: coords },
            properties: {},
          });
      } catch {
        /* no trail available */
      }
    };

    const clearTrail = () => {
      const trail = map.getSource('trail') as maplibregl.GeoJSONSource | undefined;
      if (trail) trail.setData({ type: 'FeatureCollection', features: [] });
    };

    const select = (id: string | null) => {
      selectedId = id;
      if (id) {
        void loadTrail(id);
        const s = client.store.get(id);
        setSel(s ? toSel(s) : null);
      } else {
        clearTrail();
        setSel(null);
      }
    };
    selectRef.current = select;

    const addWorldGeo = async () => {
      if (map.getSource('world')) return;
      try {
        const geo = await fetch(WORLD_GEOJSON_URL).then((r) => r.json());
        if (map.getSource('world')) return;
        map.addSource('grid', { type: 'geojson', data: graticule(10) });
        map.addLayer({
          id: 'grid',
          type: 'line',
          source: 'grid',
          paint: { 'line-color': '#141d30', 'line-width': 0.5 },
        });
        map.addSource('world', { type: 'geojson', data: geo });
        map.addLayer({
          id: 'world-fill',
          type: 'fill',
          source: 'world',
          paint: { 'fill-color': '#131c2b', 'fill-opacity': 0.9 },
        });
        map.addLayer({
          id: 'world-line',
          type: 'line',
          source: 'world',
          paint: { 'line-color': '#31405a', 'line-width': 0.7 },
        });
      } catch {
        /* geography best-effort */
      }
    };

    const setup = async () => {
      if (didSetup) return;
      didSetup = true;
      if (darkActive) await addWorldGeo();

      if (!map.hasImage('plane')) {
        map.addImage('plane', makePlaneImage(64), { sdf: true, pixelRatio: 2 });
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
            'icon-image': 'plane',
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
            'icon-opacity': ['case', ['==', ['get', 'onGround'], 1], 0.65, 1],
          },
        });

        map.on('click', 'flights', (e) => {
          const id = e.features?.[0]?.properties?.flightId as string | undefined;
          if (id) select(id);
        });
        map.on('click', (e) => {
          const hits = map.queryRenderedFeatures(e.point, { layers: ['flights'] });
          if (hits.length === 0) select(null);
        });
        map.on('mouseenter', 'flights', () => {
          map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', 'flights', () => {
          map.getCanvas().style.cursor = '';
        });
      }

      void client.connect().then(sendViewport);
      raf = requestAnimationFrame(tick);
    };

    map.on('style.load', () => void setup());

    const fallbackTimer = setTimeout(() => {
      if (!didSetup && !map.isStyleLoaded()) {
        darkActive = true;
        map.setStyle(DARK_STYLE);
      }
    }, 4000);

    map.on('moveend', sendViewport);
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
      cancelAnimationFrame(raf);
      ro.disconnect();
      unsub();
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

  if (failed) {
    return (
      <div className="fixed inset-x-0 bottom-0 top-14 grid place-items-center p-6">
        <ErrorState
          title="The live map can’t be displayed"
          description="This map needs WebGL, which your browser or GPU has turned off. Enable hardware acceleration (or WebGL) and reload — the rest of FlyTrace works without it."
          onRetry={() => window.location.reload()}
        />
      </div>
    );
  }

  return (
    <div className="fixed inset-x-0 bottom-0 top-14">
      {/* Explicit size-full — maplibre forces `position: relative` on its
          container, which would neutralise `absolute inset-0` and collapse it. */}
      <div ref={containerRef} className="size-full" />

      <div className="absolute left-3 top-3 z-10 flex items-start gap-2 sm:left-4 sm:top-4">
        <div className="flex h-9 items-center gap-2 rounded-md border border-border bg-card/85 px-3 text-sm font-medium shadow-soft-md backdrop-blur-md">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-75" />
            <span className="relative inline-flex size-2 rounded-full bg-success" />
          </span>
          <span className="tabular-nums">{count.toLocaleString()}</span>
          <span className="text-muted-foreground">live</span>
        </div>
        <SearchBox className="w-56 sm:w-72" />
      </div>

      {/* Altitude legend */}
      <div className="absolute bottom-4 right-3 z-10 hidden items-center gap-2 rounded-md border border-border bg-card/85 px-3 py-2 text-xs shadow-soft-md backdrop-blur-md sm:flex">
        <span className="text-muted-foreground">low</span>
        <span
          className="h-1.5 w-24 rounded-full"
          style={{ background: 'linear-gradient(90deg,#22c55e,#eab308,#fb923c,#38bdf8,#e2e8f0)' }}
        />
        <span className="text-muted-foreground">high</span>
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
                  <div className="text-xs text-muted-foreground">{sel.icao24.toUpperCase()}</div>
                </div>
                <button
                  type="button"
                  aria-label="Close"
                  onClick={() => selectRef.current(null)}
                  className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <X className="size-4" />
                </button>
              </div>

              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                <Metric label="Altitude" value={sel.onGround ? 'Ground' : fmtFt(sel.altFt)} />
                <Metric
                  label="Speed"
                  value={sel.gsKt != null ? `${Math.round(sel.gsKt)} kt` : '—'}
                />
                <Metric
                  label="Heading"
                  value={sel.heading != null ? `${Math.round(sel.heading)}°` : '—'}
                />
              </div>

              <Link
                href={`/flights/id/${sel.flightId}`}
                className="mt-4 flex h-9 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Details
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function fmtFt(ft: number | null): string {
  return ft != null ? `${Math.round(ft).toLocaleString()} ft` : '—';
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted/50 py-2">
      <div className="text-sm font-semibold tabular-nums">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}
