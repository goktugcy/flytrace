import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { CommandPalette } from '../components/CommandPalette';
import { ServiceWorker } from '../components/ServiceWorker';
import { SiteHeader } from '../components/site-header';
import { I18nProvider, LOCALE_COOKIE, type Locale } from '../lib/i18n';
import './globals.css';

export const metadata: Metadata = {
  title: 'FlyTrace — Live Flight Tracking',
  description: 'Watch real aircraft move in real time.',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg' },
};

export const viewport: Viewport = {
  themeColor: '#09090b',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const cookie = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale: Locale = cookie === 'tr' ? 'tr' : 'en';
  return (
    <html lang={locale} className="dark">
      <body className="min-h-dvh bg-background text-foreground antialiased">
        <I18nProvider initialLocale={locale}>
          <SiteHeader />
          {children}
          <CommandPalette />
          <ServiceWorker />
        </I18nProvider>
      </body>
    </html>
  );
}
