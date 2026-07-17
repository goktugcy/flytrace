'use client';

import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import { RealtimeClient } from '../lib/realtime-client';

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

  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE,
      center: [35, 39],
      zoom: 5,
      attributionControl: false,
    });
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
  }, []);

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      <div
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          padding: '8px 12px',
          borderRadius: 8,
          background: 'rgba(18,24,38,0.85)',
          color: 'var(--fg)',
          font: '600 13px/1.2 ui-sans-serif, system-ui',
          zIndex: 1,
        }}
      >
        ✈ {count} live aircraft
      </div>
    </div>
  );
}
