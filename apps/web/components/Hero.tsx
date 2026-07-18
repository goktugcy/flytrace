'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';

// The WebGL scene never renders on the server (no canvas/GL there).
const Hero3DScene = dynamic(() => import('./Hero3DScene').then((m) => m.Hero3DScene), {
  ssr: false,
});

type Mode = 'pending' | 'animated' | 'still' | 'fallback';

function detectMode(): Exclude<Mode, 'pending'> {
  if (typeof window === 'undefined') return 'fallback';
  // Small screens keep the lightweight CSS sky; the WebGL bundle plus model
  // asset is still not worth the mobile main-thread cost for this hero visual.
  if (!window.matchMedia?.('(min-width: 1024px)').matches) return 'fallback';
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
 * CSS "sky" is the baseline; browsers with WebGL upgrade to the engine model,
 * and viewers who prefer reduced motion get the model without rotation.
 */
export function Hero() {
  const [mode, setMode] = useState<Mode>('pending');
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMode(detectMode());
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const show3d = visible && (mode === 'animated' || mode === 'still');

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="relative aspect-4/3 w-full overflow-hidden sm:aspect-video lg:aspect-4/3"
    >
      {show3d ? <Hero3DScene animate={mode === 'animated'} /> : <CssSky />}
    </div>
  );
}

/** No-WebGL / pre-hydration baseline: transparent placeholder with a simple icon. */
function CssSky() {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'grid',
        placeItems: 'center',
      }}
    >
      <span style={{ fontSize: 72, filter: 'drop-shadow(0 8px 24px #0008)' }}>🛰️</span>
    </div>
  );
}
