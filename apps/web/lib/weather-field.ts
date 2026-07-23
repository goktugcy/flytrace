import type { WeatherField } from '@flytrace/shared';
import type maplibregl from 'maplibre-gl';

/**
 * Windy-style weather overlay: a smooth interpolated colour field rendered as a
 * MapLibre canvas raster (below the aircraft layer) plus an animated wind-
 * particle flow on a DOM canvas over the map. All data comes from the keyless
 * /weather/field grid; the field is fetched per viewport (throttled) and
 * bilinearly interpolated on the client.
 */
export type WeatherMetric = 'wind' | 'temp' | 'rain' | 'cloud';

const FIELD_SOURCE = 'wx-field';
const FIELD_LAYER = 'wx-field';
const RASTER_OPACITY = 0.62;
const COLOR_CANVAS = 128; // interpolation raster resolution (GPU upscales; keep cheap)
const PARTICLE_COUNT = 1400;
const PARTICLE_MAX_AGE = 100; // frames before a forced respawn
const WIND_DEG_PER_KT = 0.00028; // stylised advection speed (deg per kt per frame)
const TRAIL_FADE = 0.06; // fraction of the trail erased each frame
const REFETCH_MS = 60_000;

type RGBA = [number, number, number, number];

/** value → colour ramps (Windy-ish). Each returns rgba; alpha 0 = fully clear. */
function windColor(kt: number): RGBA {
  return rampColor(kt, [
    [0, [40, 90, 160, 0]],
    [5, [40, 110, 180, 150]],
    [15, [60, 170, 170, 190]],
    [25, [90, 200, 90, 205]],
    [40, [230, 205, 60, 215]],
    [60, [235, 130, 40, 225]],
    [90, [220, 50, 60, 235]],
    [130, [150, 40, 130, 240]],
  ]);
}
function tempColor(c: number): RGBA {
  return rampColor(c, [
    [-40, [120, 40, 150, 200]],
    [-20, [50, 70, 180, 200]],
    [0, [60, 150, 210, 195]],
    [10, [80, 190, 150, 190]],
    [20, [120, 200, 90, 190]],
    [30, [235, 190, 60, 200]],
    [40, [225, 90, 50, 215]],
  ]);
}
function rainColor(mm: number): RGBA {
  if (mm < 0.05) return [0, 0, 0, 0];
  return rampColor(mm, [
    [0.05, [80, 170, 220, 90]],
    [1, [60, 130, 220, 170]],
    [4, [70, 80, 210, 200]],
    [10, [120, 50, 190, 225]],
  ]);
}
function cloudColor(pct: number): RGBA {
  if (pct < 8) return [0, 0, 0, 0];
  return [220, 224, 230, Math.round((Math.min(pct, 100) / 100) * 170)];
}

function rampColor(value: number, stops: [number, RGBA][]): RGBA {
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (!first || !last) return [0, 0, 0, 0];
  if (value <= first[0]) return first[1];
  if (value >= last[0]) return last[1];
  for (let i = 1; i < stops.length; i += 1) {
    const a = stops[i - 1];
    const b = stops[i];
    if (a && b && value <= b[0]) {
      const t = (value - a[0]) / (b[0] - a[0] || 1);
      return [
        Math.round(a[1][0] + (b[1][0] - a[1][0]) * t),
        Math.round(a[1][1] + (b[1][1] - a[1][1]) * t),
        Math.round(a[1][2] + (b[1][2] - a[1][2]) * t),
        Math.round(a[1][3] + (b[1][3] - a[1][3]) * t),
      ];
    }
  }
  return last[1];
}

interface Particle {
  lon: number;
  lat: number;
  age: number;
}

export class WeatherFieldController {
  private field: WeatherField | null = null;
  private metric: WeatherMetric = 'wind';
  private enabled = false;
  private readonly canvas: HTMLCanvasElement; // particle overlay (DOM)
  private readonly colorCanvas: HTMLCanvasElement; // color field (maplibre canvas source)
  private particles: Particle[] = [];
  private raf = 0;
  private lastFetchAt = 0;
  private fetchAbort: AbortController | null = null;
  private fetchTimer: ReturnType<typeof setTimeout> | null = null;
  private refetchTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private moving = false;

  // While the map is actively panning/zooming its own render is heavy; pausing
  // the particle sim (and clearing the overlay so it doesn't smear) keeps the
  // interaction smooth. It resumes on moveend.
  private readonly onMoveStart = (): void => {
    this.moving = true;
    const ctx = this.canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  };
  private readonly onMoveEnd = (): void => {
    this.moving = false;
  };

  constructor(
    private readonly deps: {
      map: maplibregl.Map;
      container: HTMLElement;
      apiBase: string;
      beforeLayerId?: string;
    },
  ) {
    this.colorCanvas = document.createElement('canvas');
    this.colorCanvas.width = COLOR_CANVAS;
    this.colorCanvas.height = COLOR_CANVAS;

    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2;';
    this.canvas.setAttribute('aria-hidden', 'true');
  }

  setMetric(metric: WeatherMetric): void {
    this.metric = metric;
    if (this.enabled && this.field) this.drawColorField();
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) {
      this.deps.container.appendChild(this.canvas);
      this.resizeCanvas();
      this.deps.map.on('movestart', this.onMoveStart);
      this.deps.map.on('moveend', this.onMoveEnd);
      this.refetch(true);
      this.refetchTimer = setInterval(() => this.refetch(true), REFETCH_MS);
      this.startAnimation();
    } else {
      this.stop();
    }
  }

  /** Fetch a fresh field for the current viewport (throttled unless forced). */
  refetch(force = false): void {
    if (!this.enabled) return;
    if (this.fetchTimer) clearTimeout(this.fetchTimer);
    this.fetchTimer = setTimeout(() => void this.doFetch(force), 250);
  }

  private async doFetch(force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastFetchAt < 4_000) return;
    this.lastFetchAt = now;
    const b = this.deps.map.getBounds();
    // Pad the viewport a little so particles/colour don't stop at the edge.
    const padX = (b.getEast() - b.getWest()) * 0.12;
    const padY = (b.getNorth() - b.getSouth()) * 0.12;
    const w = clampLon(b.getWest() - padX);
    const e = clampLon(b.getEast() + padX);
    const s = Math.max(-85, b.getSouth() - padY);
    const n = Math.min(85, b.getNorth() + padY);
    const aspect = (e - w) / Math.max(0.0001, n - s);
    const cols = Math.max(6, Math.min(24, Math.round(14 * Math.sqrt(aspect))));
    const rows = Math.max(6, Math.min(18, Math.round(14 / Math.sqrt(aspect))));

    this.fetchAbort?.abort();
    const controller = new AbortController();
    this.fetchAbort = controller;
    try {
      const url = `${this.deps.apiBase}/api/v1/weather/field?bbox=${w.toFixed(3)},${s.toFixed(3)},${e.toFixed(3)},${n.toFixed(3)}&cols=${cols}&rows=${rows}`;
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return;
      const field = ((await res.json()) as { data: WeatherField }).data;
      if (this.destroyed || !this.enabled) return;
      this.field = field;
      this.seedParticles();
      this.drawColorField();
    } catch {
      /* aborted / offline — keep the previous field */
    }
  }

  // ── Bilinear interpolation over the grid ──
  private sample(lon: number, lat: number, arr: number[]): number {
    const f = this.field;
    if (!f) return 0;
    const [w, s, e, n] = f.bbox;
    const fx = ((lon - w) / (e - w || 1)) * (f.cols - 1);
    const fy = ((lat - s) / (n - s || 1)) * (f.rows - 1);
    if (fx < 0 || fy < 0 || fx > f.cols - 1 || fy > f.rows - 1) return Number.NaN;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, f.cols - 1);
    const y1 = Math.min(y0 + 1, f.rows - 1);
    const tx = fx - x0;
    const ty = fy - y0;
    const v00 = arr[y0 * f.cols + x0] ?? 0;
    const v10 = arr[y0 * f.cols + x1] ?? 0;
    const v01 = arr[y1 * f.cols + x0] ?? 0;
    const v11 = arr[y1 * f.cols + x1] ?? 0;
    return v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty;
  }

  // ── Colour field → MapLibre canvas raster source ──
  private drawColorField(): void {
    const f = this.field;
    const ctx = this.colorCanvas.getContext('2d');
    if (!f || !ctx) return;
    const [w, s, e, n] = f.bbox;
    const img = ctx.createImageData(COLOR_CANVAS, COLOR_CANVAS);
    for (let py = 0; py < COLOR_CANVAS; py += 1) {
      // Canvas row 0 = north (top); grid index space is bilinear on the metric.
      const lat = n - ((n - s) * py) / (COLOR_CANVAS - 1);
      for (let px = 0; px < COLOR_CANVAS; px += 1) {
        const lon = w + ((e - w) * px) / (COLOR_CANVAS - 1);
        const [r, g, bl, a] = this.metricColorInterpolated(lon, lat);
        const o = (py * COLOR_CANVAS + px) * 4;
        img.data[o] = r;
        img.data[o + 1] = g;
        img.data[o + 2] = bl;
        img.data[o + 3] = a;
      }
    }
    ctx.putImageData(img, 0, 0);

    // Static image source (NOT an animated canvas source) so the map isn't
    // forced into a continuous repaint — we only re-upload on refetch.
    const coords: [[number, number], [number, number], [number, number], [number, number]] = [
      [w, n],
      [e, n],
      [e, s],
      [w, s],
    ];
    const url = this.colorCanvas.toDataURL();
    const map = this.deps.map;
    const existing = map.getSource(FIELD_SOURCE) as maplibregl.ImageSource | undefined;
    if (existing) {
      existing.updateImage({ url, coordinates: coords });
    } else {
      map.addSource(FIELD_SOURCE, { type: 'image', url, coordinates: coords });
      const before =
        this.deps.beforeLayerId && map.getLayer(this.deps.beforeLayerId)
          ? this.deps.beforeLayerId
          : undefined;
      map.addLayer(
        {
          id: FIELD_LAYER,
          type: 'raster',
          source: FIELD_SOURCE,
          paint: {
            'raster-opacity': RASTER_OPACITY,
            'raster-fade-duration': 0,
            'raster-resampling': 'linear',
          },
        },
        before,
      );
    }
  }

  /** Bilinear metric colour so the raster is smooth between grid cells. */
  private metricColorInterpolated(lon: number, lat: number): RGBA {
    const f = this.field;
    if (!f) return [0, 0, 0, 0];
    switch (this.metric) {
      case 'temp':
        return tempColor(this.sample(lon, lat, f.tempC));
      case 'rain':
        return rainColor(this.sample(lon, lat, f.precipMm));
      case 'cloud':
        return cloudColor(this.sample(lon, lat, f.cloudPct));
      default:
        return windColor(Math.hypot(this.sample(lon, lat, f.u), this.sample(lon, lat, f.v)));
    }
  }

  // ── Wind particles ──
  private seedParticles(): void {
    this.particles = [];
    const f = this.field;
    if (!f) return;
    for (let i = 0; i < PARTICLE_COUNT; i += 1) this.particles.push(this.spawn());
  }

  private spawn(): Particle {
    const f = this.field;
    const [w, s, e, n] = f?.bbox ?? [0, 0, 1, 1];
    return {
      lon: w + Math.random() * (e - w),
      lat: s + Math.random() * (n - s),
      age: Math.floor(Math.random() * PARTICLE_MAX_AGE),
    };
  }

  private resizeCanvas(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const { clientWidth, clientHeight } = this.deps.container;
    this.canvas.width = Math.max(1, Math.floor(clientWidth * dpr));
    this.canvas.height = Math.max(1, Math.floor(clientHeight * dpr));
    const ctx = this.canvas.getContext('2d');
    if (ctx) ctx.scale(dpr, dpr);
  }

  private startAnimation(): void {
    const step = () => {
      if (!this.enabled || this.destroyed) return;
      this.drawParticles();
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  private drawParticles(): void {
    if (this.moving) return; // paused while the map interacts (perf)
    const ctx = this.canvas.getContext('2d');
    const f = this.field;
    if (!ctx || !f) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = this.canvas.width / dpr;
    const ch = this.canvas.height / dpr;

    // Fade previous trails (transparent-preserving erase).
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = `rgba(0,0,0,${TRAIL_FADE})`;
    ctx.fillRect(0, 0, cw, ch);
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineWidth = 1.1;

    const map = this.deps.map;
    for (const p of this.particles) {
      const u = this.sample(p.lon, p.lat, f.u);
      const v = this.sample(p.lon, p.lat, f.v);
      if (Number.isNaN(u) || Number.isNaN(v) || p.age > PARTICLE_MAX_AGE) {
        Object.assign(p, this.spawn(), { age: 0 });
        continue;
      }
      const prev = map.project([p.lon, p.lat]);
      if (prev.x < -20 || prev.x > cw + 20 || prev.y < -20 || prev.y > ch + 20) {
        Object.assign(p, this.spawn(), { age: 0 });
        continue;
      }
      const cosLat = Math.cos((p.lat * Math.PI) / 180) || 1;
      p.lon += (u * WIND_DEG_PER_KT) / cosLat;
      p.lat += v * WIND_DEG_PER_KT;
      p.age += 1;
      const next = map.project([p.lon, p.lat]);
      const [r, g, b] = windColor(Math.hypot(u, v));
      ctx.strokeStyle = `rgba(${r},${g},${b},0.9)`;
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(next.x, next.y);
      ctx.stroke();
    }
  }

  onResize(): void {
    if (this.enabled) this.resizeCanvas();
  }

  private stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.refetchTimer) clearInterval(this.refetchTimer);
    if (this.fetchTimer) clearTimeout(this.fetchTimer);
    this.fetchAbort?.abort();
    const map = this.deps.map;
    map.off('movestart', this.onMoveStart);
    map.off('moveend', this.onMoveEnd);
    if (map.getLayer(FIELD_LAYER)) map.removeLayer(FIELD_LAYER);
    if (map.getSource(FIELD_SOURCE)) map.removeSource(FIELD_SOURCE);
    this.canvas.remove();
    this.moving = false;
  }

  destroy(): void {
    this.destroyed = true;
    this.enabled = false;
    this.stop();
  }
}

function clampLon(lon: number): number {
  return Math.max(-180, Math.min(180, lon));
}
