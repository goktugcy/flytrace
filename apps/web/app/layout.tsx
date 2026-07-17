import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { ServiceWorker } from '../components/ServiceWorker';
import './globals.css';

export const metadata: Metadata = {
  title: 'FlyTrace — Live Flight Tracking',
  description: 'Watch real aircraft move in real time. Data via OpenSky Network.',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg' },
};

export const viewport: Viewport = {
  themeColor: '#0b0f1a',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
