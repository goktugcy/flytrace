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
const STYLE = 'https://demotiles.maplibre.org/style.json';
const LERP = 0.18; // per-frame easing toward the latest sample (docs/12 §12.5)

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
        style: STYLE,
        center: [35, 39],
        zoom: 5,
        attributionControl: false,
      });
    } catch {
      setFailed(true);
      return;
    }
    map.on('error', (e) => console.warn('maplibre error', e?.error?.message));
    map.addControl(new maplibregl.NavigationControl({ showZoom: true }), 'top-right');
    map.addControl(
      new maplibregl.AttributionControl({
        customAttribution: 'Positions © OpenSky Network · © MapLibre',
      }),
    );

    const client = new RealtimeClient({ apiBase: API_BASE, wsBase: WS_BASE });
    const rendered = new Map<string, Rendered>();
    let raf = 0;

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
      // Ease each rendered marker toward its latest authoritative sample.
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

    map.on('load', () => {
      map.addSource('flights', { type: 'geojson', data: featureCollection() });
      map.addLayer({
        id: 'flights-dot',
        type: 'circle',
        source: 'flights',
        paint: {
          'circle-radius': 5,
          'circle-color': ['case', ['==', ['get', 'onGround'], 1], '#8b97ab', '#4ea1ff'],
          'circle-stroke-width': 1,
          'circle-stroke-color': '#04122b',
        },
      });
      map.addLayer({
        id: 'flights-label',
        type: 'symbol',
        source: 'flights',
        layout: {
          'text-field': ['get', 'callsign'],
          'text-size': 10,
          'text-offset': [0, 1.2],
          'text-anchor': 'top',
        },
        paint: { 'text-color': '#e6edf7', 'text-halo-color': '#04122b', 'text-halo-width': 1 },
      });

      // Click a plane → open its flight page.
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

      void client.connect().then(sendViewport);
      raf = requestAnimationFrame(tick);
    });

    map.on('moveend', sendViewport);
    const unsub = client.store.subscribe(() => setCount(client.store.size));

    return () => {
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
