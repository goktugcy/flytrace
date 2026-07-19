'use client';

import { useEffect } from 'react';

/** Registers the service worker for PWA install + offline shell (docs/17 §17.4). */
export function ServiceWorker() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('/sw.js')
        .then((registration) => registration.update().catch(() => undefined))
        .catch(() => {
          /* SW registration is best-effort */
        });
    }
  }, []);
  return null;
}
