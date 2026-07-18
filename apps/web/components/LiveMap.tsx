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

// Optional geographic basemap. Defaults to MapLibre's public demo tiles, but
// that CDN is frequently blocked by ad/privacy extensions — when it fails to
// load, the map falls back to the self-contained dark style below so aircraft
// still render. Point NEXT_PUBLIC_MAP_STYLE at your own tile provider for a
// full basemap.
const REMOTE_STYLE =
  process.env.NEXT_PUBLIC_MAP_STYLE ?? 'https://demotiles.maplibre.org/style.json';

// Fully self-contained fallback style (no network) — a dark "radar" canvas.
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
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: REMOTE_STYLE,
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

    // Runs once, after whichever style loads (remote basemap or the dark
    // fallback). Adds the flight layer + starts the realtime feed.
    const setup = () => {
      if (didSetup) return;
      didSetup = true;
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
    map.on('style.load', setup);

    // If the remote basemap is blocked/slow (common with ad/privacy
    // extensions), swap to the self-contained dark style so aircraft still show.
    const fallbackTimer = setTimeout(() => {
      if (!didSetup && !map.isStyleLoaded()) {
        console.warn('basemap style did not load — using offline dark style');
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
