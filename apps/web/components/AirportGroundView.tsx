'use client';

import { apiBase } from '@/lib/api';

import 'maplibre-gl/dist/maplibre-gl.css';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { ArrowLeft, X } from 'lucide-react';
import maplibregl from 'maplibre-gl';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';

const API_BASE = apiBase();

/** Ground state → colour (matches the FlightRadar-style legend). */
const STATE_COLOR: Record<string, string> = {
  AT_GATE: '#22c55e',
  ARRIVED_GATE: '#22c55e',
  PARKED_REMOTE: '#16a34a',
  PUSHBACK: '#14b8a6',
  TAXI_OUT: '#eab308',
  TAXI_IN: '#eab308',
  HOLD_SHORT: '#f97316',
  LINE_UP: '#fb923c',
  TAKEOFF_ROLL: '#ef4444',
  AIRBORNE: '#3b82f6',
  CLIMB: '#3b82f6',
  CRUISE: '#3b82f6',
  DESCENT: '#8b5cf6',
  APPROACH: '#a855f7',
  LANDING: '#a855f7',
  UNKNOWN: '#9ca3af',
};

/**
 * Only runway operations are shown — arrivals on final approach/landing and
 * departures holding short / rolling / climbing out. Enroute overflights
 * (AIRBORNE/CRUISE) and idle gate/taxi/parked traffic are excluded, so the view
 * matches a FlightRadar-style "aircraft using the runway" picture.
 */
const OPS_STATES = new Set<string>([
  'APPROACH',
  'LANDING',
  'DESCENT',
  'HOLD_SHORT',
  'LINE_UP',
  'TAKEOFF_ROLL',
  'CLIMB',
]);

const FILTERS: Record<string, string[] | null> = {
  All: null,
  Landing: ['APPROACH', 'LANDING', 'DESCENT'],
  Departure: ['HOLD_SHORT', 'LINE_UP', 'TAKEOFF_ROLL', 'CLIMB'],
};

const stateColorExpr = (): maplibregl.ExpressionSpecification => {
  const match: unknown[] = ['match', ['get', 'state']];
  for (const [state, color] of Object.entries(STATE_COLOR)) match.push(state, color);
  match.push('#9ca3af');
  return match as unknown as maplibregl.ExpressionSpecification;
};

/** Top-view plane silhouette (points north), tinted per state via SDF icon-color. */
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

const REMOTE_STYLE = (dark: boolean): string =>
  dark
    ? 'https://tiles.openfreemap.org/styles/dark'
    : 'https://tiles.openfreemap.org/styles/liberty';

interface GroundAircraft {
  flightId: string | null;
  icao24: string | null;
  callsign: string | null;
  state: string;
  lat: number | null;
  lon: number | null;
  speedKt: number | null;
  headingDeg: number | null;
  altitudeFt: number | null;
  gateRef: string | null;
  runwayRef: string | null;
  lastUpdate: string;
}

interface OpRow {
  icao24: string | null;
  state: string;
  previousState: string | null;
  occurredAt: string;
}

/** Aircraft picked on the map, shown in the detail card. */
interface SelAircraft {
  callsign: string;
  icao24: string;
  state: string;
  altitudeFt: number;
  speedKt: number;
  heading: number;
  runwayRef: string;
  gateRef: string;
  flightId: string;
}

export function AirportGroundView({ icao }: { icao: string }) {
  const t = useT();
  const stateLabel = (s: string) => t(`airport.state.${s}`);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [name, setName] = useState<string>(icao.toUpperCase());
  const [count, setCount] = useState(0);
  const [emptyGeo, setEmptyGeo] = useState(false);
  const [sel, setSel] = useState<SelAircraft | null>(null);
  const [ops, setOps] = useState<OpRow[]>([]);
  const [filter, setFilter] = useState<keyof typeof FILTERS>('All');
  const filterRef = useRef(filter);
  const applyFilterRef = useRef<() => void>(() => {});

  const changeFilter = (f: keyof typeof FILTERS) => {
    setFilter(f);
    filterRef.current = f;
    applyFilterRef.current();
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: reinit only on icao change
  useEffect(() => {
    if (!containerRef.current) return;
    const dark =
      typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: REMOTE_STYLE(dark),
      center: [35, 39],
      zoom: 13,
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl({ showZoom: true }), 'top-right');
    const resize = () => map.resize();
    const ro = new ResizeObserver(resize);
    ro.observe(containerRef.current);

    // Click an aircraft → open its detail card (registered up-front; the layer
    // is added later, but layer-scoped handlers bind by id and fire once it exists).
    map.on('click', 'ground-aircraft', (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties as Record<string, unknown>;
      setSel({
        callsign: String(p.callsign || p.icao24 || '—'),
        icao24: String(p.icao24 || ''),
        state: String(p.state || 'UNKNOWN'),
        altitudeFt: Number(p.altitudeFt ?? -1),
        speedKt: Number(p.speedKt ?? -1),
        heading: Number(p.heading ?? 0),
        runwayRef: String(p.runwayRef || ''),
        gateRef: String(p.gateRef || ''),
        flightId: String(p.flightId || ''),
      });
    });
    map.on('mouseenter', 'ground-aircraft', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'ground-aircraft', () => {
      map.getCanvas().style.cursor = '';
    });

    let groundTimer: ReturnType<typeof setInterval> | null = null;
    let opsTimer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    const addGeometryLayers = (fc: GeoJSON.FeatureCollection) => {
      if (map.getSource('airport-geo')) return;
      map.addSource('airport-geo', { type: 'geojson', data: fc });
      map.addLayer({
        id: 'apron-fill',
        type: 'fill',
        source: 'airport-geo',
        filter: ['in', ['get', 'kind'], ['literal', ['apron', 'terminal', 'hangar']]],
        paint: {
          'fill-color': [
            'match',
            ['get', 'kind'],
            'terminal',
            '#475569',
            'hangar',
            '#3f3f46',
            '#334155',
          ],
          'fill-opacity': 0.45,
        },
      });
      map.addLayer({
        id: 'taxiway-line',
        type: 'line',
        source: 'airport-geo',
        filter: ['==', ['get', 'kind'], 'taxiway'],
        paint: { 'line-color': '#ca8a04', 'line-width': 1.6, 'line-opacity': 0.8 },
      });
      map.addLayer({
        id: 'runway-line',
        type: 'line',
        source: 'airport-geo',
        filter: ['==', ['get', 'kind'], 'runway'],
        paint: { 'line-color': '#e5e7eb', 'line-width': 3.5 },
      });
      // Gate/parking stands are reference geometry — kept dim and small so the
      // live aircraft markers (bright, haloed) read clearly on top of them.
      map.addLayer({
        id: 'gate-point',
        type: 'circle',
        source: 'airport-geo',
        filter: ['in', ['get', 'kind'], ['literal', ['gate', 'parking']]],
        paint: {
          'circle-radius': 2,
          'circle-color': '#64748b',
          'circle-opacity': 0.4,
        },
      });
    };

    const addAircraftLayer = () => {
      if (map.getSource('ground-aircraft')) return;
      if (!map.hasImage('ac-plane')) {
        map.addImage('ac-plane', makePlaneImage(64), { sdf: true, pixelRatio: 2 });
      }
      map.addSource('ground-aircraft', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      // Soft glow behind each aircraft so it pops out from the dim stand dots.
      map.addLayer({
        id: 'ground-aircraft-halo',
        type: 'circle',
        source: 'ground-aircraft',
        paint: {
          'circle-radius': 15,
          'circle-color': stateColorExpr(),
          'circle-opacity': 0.16,
        },
      });
      // Heading-rotated plane icon (FR24-style), tinted by state, with callsign.
      map.addLayer({
        id: 'ground-aircraft',
        type: 'symbol',
        source: 'ground-aircraft',
        layout: {
          'icon-image': 'ac-plane',
          'icon-rotate': ['get', 'heading'],
          'icon-rotation-alignment': 'map',
          'icon-size': 0.6,
          'icon-allow-overlap': true,
          'text-field': ['get', 'callsign'],
          'text-font': ['Noto Sans Regular'], // openfreemap ships Noto, not the maplibre default
          'text-size': 11,
          'text-offset': [0, 1.6],
          'text-anchor': 'top',
          'text-optional': true,
        },
        paint: {
          'icon-color': stateColorExpr(),
          'icon-halo-color': '#ffffff',
          'icon-halo-width': 1.1,
          'text-color': '#f1f5f9',
          'text-halo-color': '#050912',
          'text-halo-width': 1.4,
        },
      });
      applyFilter();
    };

    const applyFilter = () => {
      if (!map.getLayer('ground-aircraft')) return;
      const states = FILTERS[filterRef.current];
      const f = states
        ? (['in', ['get', 'state'], ['literal', states]] as maplibregl.FilterSpecification)
        : null;
      map.setFilter('ground-aircraft-halo', f);
      map.setFilter('ground-aircraft', f);
    };
    applyFilterRef.current = applyFilter;

    const loadGround = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/v1/airport/${icao}/ground`);
        if (!res.ok) return;
        const aircraft = ((await res.json()) as { data: { aircraft: GroundAircraft[] } }).data
          .aircraft;
        if (cancelled) return;
        // Runway operations only: arrivals on final + departures rolling/climbing.
        const ops = aircraft.filter(
          (a) => a.lat != null && a.lon != null && OPS_STATES.has(a.state),
        );
        setCount(ops.length);
        const src = map.getSource('ground-aircraft') as maplibregl.GeoJSONSource | undefined;
        if (src) {
          src.setData({
            type: 'FeatureCollection',
            features: ops.map((a) => ({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [a.lon as number, a.lat as number] },
              properties: {
                state: a.state,
                heading: a.headingDeg ?? 0,
                callsign: a.callsign ?? a.icao24 ?? '',
                icao24: a.icao24 ?? '',
                flightId: a.flightId ?? '',
                altitudeFt: a.altitudeFt ?? -1,
                speedKt: a.speedKt ?? -1,
                gateRef: a.gateRef ?? '',
                runwayRef: a.runwayRef ?? '',
              },
            })),
          });
        }
      } catch {
        /* keep the last frame */
      }
    };

    const loadOps = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/v1/airport/${icao}/operations?limit=40`);
        if (!res.ok) return;
        const rows = ((await res.json()) as { data: { operations: OpRow[] } }).data.operations;
        if (!cancelled) setOps(rows);
      } catch {
        /* ignore */
      }
    };

    const init = async () => {
      try {
        const [headerRes, geoRes] = await Promise.all([
          fetch(`${API_BASE}/api/v1/airport/${icao}`),
          fetch(`${API_BASE}/api/v1/airport/${icao}/geometry`),
        ]);
        if (headerRes.status === 404) {
          if (!cancelled) setStatus('missing');
          return;
        }
        if (!headerRes.ok || !geoRes.ok) {
          if (!cancelled) setStatus('error');
          return;
        }
        const header = (
          (await headerRes.json()) as {
            data: { airport: { name: string; lat: number; lon: number } };
          }
        ).data.airport;
        const fc = ((await geoRes.json()) as { data: GeoJSON.FeatureCollection }).data;
        if (cancelled) return;
        setName(header.name);
        setStatus('ready');
        setEmptyGeo(fc.features.length === 0);

        // Add sources/layers + frame the airport once the map is ready. Guarding
        // on map.loaded() (with on('load') otherwise) is race-free — the check
        // and the listener registration run synchronously, so the event cannot
        // slip between them — and it avoids the isStyleLoaded()/once pitfall.
        const paint = () => {
          if (cancelled) return;
          addGeometryLayers(fc);
          addAircraftLayer();
          map.resize(); // ensure real dimensions before fitting the camera
          // Frame the airport, but never tighter than the ~15 km area the API
          // returns aircraft for — otherwise arriving/departing traffic on the
          // approach corridors sits off-screen and the field looks empty.
          const b = boundsOf(fc);
          const cx = b ? (b[0] + b[2]) / 2 : header.lon;
          const cy = b ? (b[1] + b[3]) / 2 : header.lat;
          const hw = Math.max(b ? (b[2] - b[0]) / 2 : 0, 0.17);
          const hh = Math.max(b ? (b[3] - b[1]) / 2 : 0, 0.13);
          map.fitBounds([cx - hw, cy - hh, cx + hw, cy + hh], { padding: 40, duration: 0 });
          void loadGround();
        };
        if (map.loaded()) paint();
        else map.on('load', paint);

        await loadOps();
        groundTimer = setInterval(loadGround, 4000);
        opsTimer = setInterval(loadOps, 15_000);
      } catch {
        if (!cancelled) setStatus('error');
      }
    };
    void init();

    return () => {
      cancelled = true;
      if (groundTimer) clearInterval(groundTimer);
      if (opsTimer) clearInterval(opsTimer);
      ro.disconnect();
      map.remove();
    };
  }, [icao]);

  const legend = useMemo(
    () => ['APPROACH', 'LANDING', 'HOLD_SHORT', 'LINE_UP', 'TAKEOFF_ROLL', 'CLIMB'],
    [],
  );

  return (
    <div className="fixed inset-x-0 bottom-0 top-14">
      <div ref={containerRef} className="size-full" />

      <div className="absolute left-3 top-3 z-10 flex flex-col gap-2 sm:left-4 sm:top-4">
        <div className="flex items-center gap-2 rounded-md border border-border bg-card/90 px-3 py-2 shadow-soft-md backdrop-blur-md">
          <Link href="/map" className="text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-4" />
          </Link>
          <span className="font-semibold">{icao.toUpperCase()}</span>
          <span className="max-w-[40vw] truncate text-sm text-muted-foreground">{name}</span>
          <span className="ml-2 tabular-nums text-sm text-muted-foreground">
            {count} {t('airport.arrDep')}
          </span>
        </div>
        <div className="flex items-center rounded-md border border-border bg-card/85 p-0.5 shadow-soft-md backdrop-blur-md">
          {(Object.keys(FILTERS) as (keyof typeof FILTERS)[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => changeFilter(f)}
              aria-pressed={filter === f}
              className={cn(
                'rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors',
                filter === f
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t(`airport.filter.${f.toLowerCase()}`)}
            </button>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="absolute bottom-4 left-3 z-10 hidden flex-col gap-1 rounded-md border border-border bg-card/85 px-3 py-2 text-xs shadow-soft-md backdrop-blur-md sm:flex">
        {legend.map((state) => (
          <div key={state} className="flex items-center gap-2">
            <span className="size-2.5 rounded-full" style={{ background: STATE_COLOR[state] }} />
            <span className="text-muted-foreground">{stateLabel(state)}</span>
          </div>
        ))}
      </div>

      {/* Operations timeline */}
      <div className="absolute inset-x-3 bottom-3 z-10 max-h-40 overflow-y-auto rounded-md border border-border bg-card/90 p-3 text-xs shadow-soft-lg backdrop-blur-md sm:inset-x-auto sm:right-4 sm:top-4 sm:bottom-auto sm:w-72">
        <div className="mb-1 font-semibold">{t('airport.operations')}</div>
        {ops.length === 0 ? (
          <p className="text-muted-foreground">{t('airport.noOps')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {ops.map((o, i) => (
              <li key={`${o.icao24}-${o.occurredAt}-${i}`} className="flex items-center gap-2 py-1">
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: STATE_COLOR[o.state] ?? '#9ca3af' }}
                />
                <span className="tabular-nums text-muted-foreground">
                  {new Date(o.occurredAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                <span className="font-medium">{o.icao24 ?? '—'}</span>
                <span className="ml-auto text-muted-foreground">{o.state}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {sel && (
        <div className="absolute bottom-4 left-1/2 z-30 w-[min(92vw,320px)] -translate-x-1/2 rounded-lg border border-border bg-card/95 p-4 shadow-soft-lg backdrop-blur-md">
          <button
            type="button"
            onClick={() => setSel(null)}
            className="absolute right-3 top-3 text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
          <div className="flex items-center gap-2">
            <span
              className="size-2.5 rounded-full"
              style={{ background: STATE_COLOR[sel.state] ?? '#9ca3af' }}
            />
            <span className="text-lg font-semibold">{sel.callsign}</span>
            {sel.icao24 && (
              <span className="text-xs uppercase text-muted-foreground">{sel.icao24}</span>
            )}
          </div>
          <div className="mt-0.5 text-sm text-muted-foreground">{stateLabel(sel.state)}</div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">{t('airport.metric.alt')}</div>
              <div className="tabular-nums">
                {sel.altitudeFt >= 0 ? `${sel.altitudeFt.toLocaleString()} ft` : '—'}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{t('airport.metric.speed')}</div>
              <div className="tabular-nums">
                {sel.speedKt >= 0 ? `${Math.round(sel.speedKt)} kt` : '—'}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{t('airport.metric.heading')}</div>
              <div className="tabular-nums">{Math.round(sel.heading)}°</div>
            </div>
          </div>
          {(sel.runwayRef || sel.gateRef) && (
            <div className="mt-2 text-sm text-muted-foreground">
              {sel.runwayRef ? `${t('airport.runway')} ${sel.runwayRef}` : ''}
              {sel.runwayRef && sel.gateRef ? ' · ' : ''}
              {sel.gateRef ? `${t('airport.gate')} ${sel.gateRef}` : ''}
            </div>
          )}
          {sel.flightId && (
            <Link
              href={`/flights/id/${sel.flightId}`}
              className="mt-3 inline-block text-sm font-medium text-accent-foreground hover:underline"
            >
              {t('airport.fullDetails')} →
            </Link>
          )}
        </div>
      )}

      {status === 'ready' && emptyGeo && (
        <div className="pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-card/90 px-4 py-3 text-center text-sm text-muted-foreground shadow-soft-lg backdrop-blur-md">
          {t('airport.noGeometry', { icao: icao.toUpperCase() })}
          <br />
          {t('airport.noGeometryHint')}
        </div>
      )}

      {status === 'missing' && (
        <div className="absolute inset-0 grid place-items-center bg-background/70">
          <p className="text-muted-foreground">
            {t('airport.notFound', { icao: icao.toUpperCase() })}
          </p>
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 grid place-items-center bg-background/70">
          <p className="text-muted-foreground">{t('airport.loadError')}</p>
        </div>
      )}
    </div>
  );
}

/** LngLatBounds covering every coordinate in a FeatureCollection, or null. */
function boundsOf(fc: GeoJSON.FeatureCollection): [number, number, number, number] | null {
  let w = 180;
  let s = 90;
  let e = -180;
  let n = -90;
  let any = false;
  const visit = (c: GeoJSON.Position) => {
    any = true;
    w = Math.min(w, c[0]);
    e = Math.max(e, c[0]);
    s = Math.min(s, c[1]);
    n = Math.max(n, c[1]);
  };
  const walk = (g: GeoJSON.Geometry) => {
    if (g.type === 'Point') visit(g.coordinates);
    else if (g.type === 'LineString' || g.type === 'MultiPoint') g.coordinates.forEach(visit);
    else if (g.type === 'Polygon' || g.type === 'MultiLineString')
      for (const r of g.coordinates) r.forEach(visit);
    else if (g.type === 'MultiPolygon')
      for (const poly of g.coordinates) for (const r of poly) r.forEach(visit);
  };
  for (const f of fc.features) if (f.geometry) walk(f.geometry);
  return any ? [w, s, e, n] : null;
}
