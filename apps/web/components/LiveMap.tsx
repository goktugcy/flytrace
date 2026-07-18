'use client';

import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { SearchBox } from '@/components/SearchBox';
import { ErrorState } from '@/components/ui/states';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
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
const LERP = 0.18; // per-frame easing toward the latest sample (docs/12 §12.5)

// By default the map uses a self-contained dark style + a bundled, first-party
// world-borders GeoJSON (see public/geo/world.json) so geography always renders
// — external tile CDNs are routinely blocked by ad/privacy extensions. Set
// NEXT_PUBLIC_MAP_STYLE to a tile provider's style URL to opt into a richer
// basemap (at the risk of it being blocked).
const REMOTE_STYLE = process.env.NEXT_PUBLIC_MAP_STYLE;
const WORLD_GEOJSON_URL = '/geo/world.json';

// Fully self-contained base style (no network) — a dark "radar" canvas.
const DARK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0b1020' } }],
};

interface Rendered {
  lat: number;
  lon: number;
}

export function LiveMap() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [count, setCount] = useState(0);
  const [failed, setFailed] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (!containerRef.current) return;
    if (!webglAvailable()) {
      setFailed(true);
      return;
    }

    let map: maplibregl.Map;
    let darkActive = !REMOTE_STYLE; // using the offline dark base (needs bundled geography)
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: REMOTE_STYLE ?? DARK_STYLE,
        center: [35, 39],
        zoom: 5,
        attributionControl: false,
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

    const client = new RealtimeClient({ apiBase: API_BASE, wsBase: WS_BASE });
    const rendered = new Map<string, Rendered>();
    let raf = 0;
    let didSetup = false;

    const featureCollection = (): GeoJSON.FeatureCollection => ({
      type: 'FeatureCollection',
      features: client.store.list().map((f) => {
        const r = rendered.get(f.flightId) ?? { lat: f.lat, lon: f.lon };
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
          properties: {
            flightId: f.flightId,
            callsign: f.callsign ?? f.icao24,
            onGround: f.onGround ? 1 : 0,
          },
        };
      }),
    });

    const tick = () => {
      for (const f of client.store.list()) {
        const r = rendered.get(f.flightId);
        if (!r) rendered.set(f.flightId, { lat: f.lat, lon: f.lon });
        else {
          r.lat += (f.lat - r.lat) * LERP;
          r.lon += (f.lon - r.lon) * LERP;
        }
      }
      for (const id of rendered.keys()) if (!client.store.get(id)) rendered.delete(id);
      const src = map.getSource('flights') as maplibregl.GeoJSONSource | undefined;
      if (src) src.setData(featureCollection());
      raf = requestAnimationFrame(tick);
    };

    const sendViewport = () => {
      const b = map.getBounds();
      client.setViewport([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
    };

    // First-party world geography (country fill + borders) for the dark base —
    // served from our own origin so ad/privacy extensions can't block it.
    const addWorldGeo = async () => {
      if (map.getSource('world')) return;
      try {
        const geo = await fetch(WORLD_GEOJSON_URL).then((r) => r.json());
        if (map.getSource('world')) return;
        map.addSource('world', { type: 'geojson', data: geo });
        map.addLayer({
          id: 'world-fill',
          type: 'fill',
          source: 'world',
          paint: { 'fill-color': '#161f2e' },
        });
        map.addLayer({
          id: 'world-line',
          type: 'line',
          source: 'world',
          paint: { 'line-color': '#2c3a52', 'line-width': 0.6 },
        });
      } catch {
        /* geography is best-effort; aircraft still render on the dark canvas */
      }
    };

    // Runs once, after whichever style loads (remote basemap or the dark
    // base/fallback). Adds geography (offline base) + the flight layer + feed.
    const setup = async () => {
      if (didSetup) return;
      didSetup = true;
      if (darkActive) await addWorldGeo();
      if (!map.getSource('flights')) {
        map.addSource('flights', { type: 'geojson', data: featureCollection() });
        map.addLayer({
          id: 'flights-dot',
          type: 'circle',
          source: 'flights',
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 3, 3, 8, 6],
            'circle-color': ['case', ['==', ['get', 'onGround'], 1], '#71717a', '#3b82f6'],
            'circle-stroke-width': 1.5,
            'circle-stroke-color': '#0b1020',
          },
        });
        map.on('click', 'flights-dot', (e) => {
          const id = e.features?.[0]?.properties?.flightId as string | undefined;
          if (id) router.push(`/flights/id/${id}`);
        });
        map.on('mouseenter', 'flights-dot', () => {
          map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', 'flights-dot', () => {
          map.getCanvas().style.cursor = '';
        });
      }
      void client.connect().then(sendViewport);
      raf = requestAnimationFrame(tick);
    };

    // `style.load` fires for the initial style and after any setStyle().
    map.on('style.load', () => void setup());

    // If a remote basemap (opt-in) is blocked/slow, swap to the offline dark
    // style + bundled geography so the map still renders.
    const fallbackTimer = setTimeout(() => {
      if (!didSetup && !map.isStyleLoaded()) {
        console.warn('basemap style did not load — using offline dark style');
        darkActive = true;
        map.setStyle(DARK_STYLE);
      }
    }, 4000);

    map.on('moveend', sendViewport);
    const unsub = client.store.subscribe(() => setCount(client.store.size));

    return () => {
      clearTimeout(fallbackTimer);
      cancelAnimationFrame(raf);
      unsub();
      client.close();
      map.remove();
    };
  }, [router]);

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
      <div ref={containerRef} className="absolute inset-0" />

      {/* Floating controls (top-left), above the map canvas. */}
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
    </div>
  );
}
