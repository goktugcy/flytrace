'use client';

import { useEffect, useRef, useState } from 'react';

const AIRLINES = [
  'THY',
  'PGT',
  'SXS',
  'QTR',
  'DLH',
  'AFR',
  'UAE',
  'RYR',
  'EZY',
  'KLM',
  'BAW',
  'AAL',
  'SWR',
  'ETD',
];
const COLORS = ['#38bdf8', '#22d3ee', '#818cf8', '#5eead4', '#7dd3fc', '#a5b4fc'];
// Up-pointing jet silhouette (matches the map icon); rotate(90) → nose points +x.
const PLANE_POINTS =
  '0,-29 2,-10 2,-4 29,13 29,16 2,6 2,20 14,29 14,31 0,25 -14,31 -14,29 -2,20 -2,6 -29,16 -29,13 -2,-4 -2,-10';
const COUNT = 9;

interface Plane {
  id: number;
  callsign: string;
  color: string;
  dir: 1 | -1;
  y0: number;
  amp: number;
  freq: number;
  phase: number;
  speed: number;
  t: number;
  fl: number;
  gs: number;
}

interface HoverInfo {
  callsign: string;
  fl: number;
  gs: number;
  color: string;
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(arr: readonly T[]) => arr[Math.floor(Math.random() * arr.length)] as T;

function makePlane(id: number): Plane {
  return {
    id,
    callsign: `${pick(AIRLINES)}${Math.floor(rnd(10, 9990))}`,
    color: COLORS[id % COLORS.length] as string,
    dir: Math.random() < 0.5 ? 1 : -1,
    y0: rnd(0.1, 0.9),
    amp: rnd(0.03, 0.13),
    freq: rnd(0.4, 1.3),
    phase: rnd(0, Math.PI * 2),
    speed: rnd(0.03, 0.075) / 1000, // progress per ms → full traverse ~13-33 s
    t: Math.random(),
    fl: Math.round(rnd(28, 41)),
    gs: Math.round(rnd(38, 55)) * 10,
  };
}

/**
 * Landing hero backdrop — aircraft drift across the whole hero on a transparent,
 * frameless "map demo" surface (faint graticule + route arcs). Hovering a plane
 * reveals a live-style flight tag. rAF-driven DOM transforms; static + still for
 * reduced-motion. Callsigns are generated client-side to avoid hydration drift.
 */
export function HeroFlights() {
  const [planes, setPlanes] = useState<Plane[]>([]);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<number, SVGSVGElement>());
  const list = useRef<Plane[]>([]);
  const hoveredId = useRef<number | null>(null);

  useEffect(() => {
    const arr = Array.from({ length: COUNT }, (_, i) => makePlane(i));
    list.current = arr;
    setPlanes(arr);
    const reduce = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

    const xf = (p: Plane, t: number) => (p.dir === 1 ? t : 1 - t);
    const yf = (p: Plane, t: number) => p.y0 + p.amp * Math.sin(6.2832 * p.freq * t + p.phase);

    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(now - last, 64);
      last = now;
      const W = wrapRef.current?.clientWidth ?? 0;
      const H = wrapRef.current?.clientHeight ?? 0;
      for (const p of list.current) {
        if (!reduce) {
          p.t += p.speed * dt;
          if (p.t > 1) p.t -= 1;
        }
        const x = xf(p, p.t) * W;
        const y = yf(p, p.t) * H;
        const e = 0.002;
        const deg = Math.atan2(
          (yf(p, p.t + e) - yf(p, p.t)) * H,
          (xf(p, p.t + e) - xf(p, p.t)) * W,
        );
        const n = nodes.current.get(p.id);
        if (n) n.style.transform = `translate(${x}px, ${y}px) rotate(${deg * 57.2958}deg)`;
        if (hoveredId.current === p.id && tipRef.current) {
          tipRef.current.style.transform = `translate(${x}px, ${y}px)`;
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      ref={wrapRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
    >
      {/* Faint map graticule */}
      <div
        className="absolute inset-0 text-foreground opacity-[0.05]"
        style={{
          backgroundImage:
            'linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)',
          backgroundSize: '52px 52px',
          maskImage: 'radial-gradient(80% 80% at 50% 45%, black, transparent 90%)',
        }}
      />
      {/* Faint route arcs (decorative, stretched) */}
      <svg
        aria-hidden="true"
        className="absolute inset-0 size-full text-accent-bright opacity-20"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        <g fill="none" stroke="currentColor" strokeWidth={0.15} strokeDasharray="1 2">
          <path d="M -5 30 C 30 12, 70 22, 105 8" />
          <path d="M -5 78 C 35 66, 65 46, 105 34" />
          <path d="M 105 20 C 70 42, 35 40, -5 66" />
        </g>
      </svg>

      {/* Aircraft */}
      {planes.map((p) => (
        <svg
          key={p.id}
          ref={(el) => {
            if (el) nodes.current.set(p.id, el);
            else nodes.current.delete(p.id);
          }}
          viewBox="-32 -32 64 64"
          width={22}
          height={22}
          className="pointer-events-auto absolute left-0 top-0 cursor-pointer transition-[filter] hover:brightness-125"
          style={{
            marginLeft: -11,
            marginTop: -11,
            color: p.color,
            willChange: 'transform',
            filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.45))',
          }}
          onMouseEnter={() => {
            hoveredId.current = p.id;
            setHover({ callsign: p.callsign, fl: p.fl, gs: p.gs, color: p.color });
          }}
          onMouseLeave={() => {
            hoveredId.current = null;
            setHover(null);
          }}
        >
          <title>{p.callsign}</title>
          <polygon points={PLANE_POINTS} transform="rotate(90)" fill="currentColor" />
        </svg>
      ))}

      {/* Hover flight tag — always mounted, follows the plane; toggled by opacity */}
      <div
        ref={tipRef}
        className="absolute left-0 top-0 will-change-transform transition-opacity duration-150"
        style={{ opacity: hover ? 1 : 0 }}
      >
        <div className="-translate-x-1/2 translate-y-[-170%] whitespace-nowrap rounded-md border border-border bg-card/95 px-2.5 py-1.5 text-xs shadow-soft-md backdrop-blur">
          <span className="font-mono font-semibold" style={{ color: hover?.color ?? '#38bdf8' }}>
            {hover?.callsign ?? ''}
          </span>
          <span className="ml-2 tabular-nums text-muted-foreground">
            FL{hover?.fl ?? 0} · {hover?.gs ?? 0} kt
          </span>
        </div>
      </div>
    </div>
  );
}
