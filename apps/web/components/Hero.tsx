'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';

// The WebGL scene never renders on the server (no canvas/GL there).
const Hero3DScene = dynamic(() => import('./Hero3DScene').then((m) => m.Hero3DScene), {
  ssr: false,
});

type Mode = 'pending' | 'animated' | 'still' | 'fallback';

function detectMode(): Exclude<Mode, 'pending'> {
  if (typeof window === 'undefined') return 'fallback';
  // No-WebGL → CSS fallback.
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return 'fallback';
  } catch {
    return 'fallback';
  }
  // Reduced-motion → render the scene, but static (no rotation).
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  return reduce ? 'still' : 'animated';
}

/**
 * Landing hero visual (docs/17 §17.4). Progressive enhancement: a self-contained
 * CSS "sky" is the baseline; browsers with WebGL upgrade to a React Three Fiber
 * globe, and viewers who prefer reduced motion get the globe without rotation.
 */
export function Hero() {
  const [mode, setMode] = useState<Mode>('pending');

  useEffect(() => {
    setMode(detectMode());
  }, []);

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'relative',
        width: '100%',
        height: 320,
        marginTop: '2.5rem',
        borderRadius: 16,
        overflow: 'hidden',
        background: 'radial-gradient(120% 120% at 70% 20%, #12335b 0%, #0a1626 55%, #060d18 100%)',
        border: '1px solid #1e2636',
      }}
    >
      {(mode === 'animated' || mode === 'still') && <Hero3DScene animate={mode === 'animated'} />}
      {(mode === 'pending' || mode === 'fallback') && <CssSky />}
    </div>
  );
}

/** No-WebGL / pre-hydration baseline: layered gradient sky with a drifting plane. */
function CssSky() {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'grid',
        placeItems: 'center',
        backgroundImage:
          'radial-gradient(1px 1px at 20% 30%, #ffffff55 0, transparent 100%),' +
          'radial-gradient(1px 1px at 60% 70%, #ffffff44 0, transparent 100%),' +
          'radial-gradient(1px 1px at 80% 20%, #ffffff33 0, transparent 100%)',
      }}
    >
      <span style={{ fontSize: 72, filter: 'drop-shadow(0 8px 24px #0008)' }}>🛰️</span>
    </div>
  );
}
