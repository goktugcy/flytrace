'use client';

import { useT } from '@/lib/i18n';
import { useEffect, useState } from 'react';

// Scope centre = viewBox centre, so it stays put at any panel size.
const CX = 200;
const CY = 150;
const RINGS = [44, 88, 132, 176];

/** Flight routes (viewBox 0..400 × 0..300) the aircraft track along. */
const ROUTES = [
  { id: 'r1', d: 'M -30 78 C 110 40 250 70 440 34', dur: 18, color: '#38bdf8' },
  { id: 'r2', d: 'M -30 250 C 130 214 260 150 440 108', dur: 23, color: '#22d3ee' },
  { id: 'r3', d: 'M 440 66 C 300 128 150 132 -30 210', dur: 27, color: '#818cf8' },
  { id: 'r4', d: 'M 70 -30 C 150 110 250 170 220 330', dur: 31, color: '#38bdf8' },
] as const;

// Up-pointing jet silhouette (matches the map icon), centred on the origin.
const PLANE_POINTS =
  '0,-29 2,-10 2,-4 29,13 29,16 2,6 2,20 14,29 14,31 0,25 -14,31 -14,29 -2,20 -2,6 -29,16 -29,13 -2,-4 -2,-10';

/**
 * Landing hero visual — a live "radar scope" that mirrors what FlyTrace does:
 * a sweeping beam, range rings, routes and aircraft tracking along them
 * (auto-rotated to heading). Self-contained SVG/SMIL, light on the main thread,
 * and static for viewers who prefer reduced motion.
 */
export function HeroRadar() {
  const t = useT();
  const [animate, setAnimate] = useState(true);

  useEffect(() => {
    setAnimate(!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  }, []);

  return (
    <div className="relative aspect-4/3 w-full">
      {/* Ambient glow behind the scope */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -inset-6 -z-10 opacity-70 blur-2xl"
        style={{
          background: 'radial-gradient(55% 55% at 50% 45%, rgba(56,189,248,0.30), transparent 72%)',
        }}
      />

      <div className="relative size-full overflow-hidden rounded-2xl border border-white/10 bg-[#070d1a] shadow-soft-lg">
        <svg
          viewBox="0 0 400 300"
          className="size-full"
          preserveAspectRatio="xMidYMid slice"
          role="img"
          aria-label="Live radar visualisation"
        >
          <defs>
            <radialGradient id="hr-bg" cx="50%" cy="50%" r="75%">
              <stop offset="0%" stopColor="#0e1a33" />
              <stop offset="62%" stopColor="#080f20" />
              <stop offset="100%" stopColor="#05060d" />
            </radialGradient>
            <linearGradient id="hr-beam" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.5" />
              <stop offset="100%" stopColor="#38bdf8" stopOpacity="0" />
            </linearGradient>
            <symbol id="hr-plane" viewBox="-32 -32 64 64">
              {/* rotate 90° so the nose points along +x (travel direction) */}
              <polygon points={PLANE_POINTS} transform="rotate(90)" />
            </symbol>
          </defs>

          <rect x="0" y="0" width="400" height="300" fill="url(#hr-bg)" />

          {/* Range rings + crosshair */}
          <g stroke="#38bdf8" fill="none">
            {RINGS.map((r) => (
              <circle key={r} cx={CX} cy={CY} r={r} strokeOpacity={0.1} />
            ))}
            <line x1={CX} y1={CY - 190} x2={CX} y2={CY + 190} strokeOpacity={0.07} />
            <line x1={CX - 250} y1={CY} x2={CX + 250} y2={CY} strokeOpacity={0.07} />
          </g>

          {/* Routes */}
          {ROUTES.map((r) => (
            <path
              key={r.id}
              id={r.id}
              d={r.d}
              fill="none"
              stroke={r.color}
              strokeOpacity={0.2}
              strokeWidth={1}
              strokeDasharray="2 5"
              strokeLinecap="round"
            />
          ))}

          {/* Rotating radar beam (soft cone + sharp leading edge) */}
          <g>
            <line
              x1={CX}
              y1={CY}
              x2={CX}
              y2={CY - 190}
              stroke="url(#hr-beam)"
              strokeWidth={54}
              strokeLinecap="round"
            />
            <line
              x1={CX}
              y1={CY}
              x2={CX}
              y2={CY - 190}
              stroke="#7dd3fc"
              strokeOpacity={0.6}
              strokeWidth={1.5}
            />
            {animate && (
              <animateTransform
                attributeName="transform"
                type="rotate"
                from={`0 ${CX} ${CY}`}
                to={`360 ${CX} ${CY}`}
                dur="6.5s"
                repeatCount="indefinite"
              />
            )}
          </g>

          {/* Airport hubs */}
          {[
            [CX, CY],
            [88, 210],
            [318, 96],
          ].map(([cx, cy]) => (
            <g key={`${cx}-${cy}`}>
              <circle cx={cx} cy={cy} r={7} fill="#38bdf8" fillOpacity={0.14}>
                {animate && (
                  <animate attributeName="r" values="5;12;5" dur="3s" repeatCount="indefinite" />
                )}
              </circle>
              <circle cx={cx} cy={cy} r={2.4} fill="#7dd3fc" />
            </g>
          ))}

          {/* Aircraft tracking the routes, auto-rotated to heading */}
          {ROUTES.map((r, i) => (
            <g key={`p-${r.id}`} fill={r.color}>
              <use href="#hr-plane" width={20} height={20} x={-10} y={-10}>
                {animate ? (
                  <animateMotion
                    dur={`${r.dur}s`}
                    begin={`${-i * 4}s`}
                    repeatCount="indefinite"
                    rotate="auto"
                  >
                    <mpath href={`#${r.id}`} />
                  </animateMotion>
                ) : (
                  <animateMotion
                    dur="1s"
                    fill="freeze"
                    keyPoints="0.4;0.4"
                    keyTimes="0;1"
                    calcMode="linear"
                    rotate="auto"
                  >
                    <mpath href={`#${r.id}`} />
                  </animateMotion>
                )}
              </use>
            </g>
          ))}
        </svg>

        {/* Live flight tag overlay */}
        <div className="absolute left-4 top-4 flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 backdrop-blur-md">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
          </span>
          <span className="font-mono text-xs font-semibold text-sky-100">THY1 · FL370</span>
          <span className="text-[11px] uppercase tracking-wide text-sky-300/70">
            {t('common.live')}
          </span>
        </div>

        {/* Vignette / screen sheen */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(120% 120% at 50% 50%, transparent 60%, rgba(0,0,0,0.45) 100%)',
          }}
        />
      </div>
    </div>
  );
}
