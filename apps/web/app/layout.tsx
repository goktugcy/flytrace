import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { ServiceWorker } from '../components/ServiceWorker';
import { SiteHeader } from '../components/site-header';
import './globals.css';

export const metadata: Metadata = {
  title: 'FlyTrace — Live Flight Tracking',
  description: 'Watch real aircraft move in real time. Data via OpenSky Network.',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg' },
};

export const viewport: Viewport = {
  themeColor: '#09090b',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <SiteHeader />
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
