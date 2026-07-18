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
    // suppressHydrationWarning: browser extensions (dark-mode, translators,
    // Grammarly…) inject attributes on <html>/<body> before hydration; the app
    // markup itself is SSR-correct. This only suppresses attribute noise on
    // these two elements, not real content mismatches deeper in the tree.
    <html lang={locale} className="dark" suppressHydrationWarning>
      <body
        className="min-h-dvh bg-background text-foreground antialiased"
        suppressHydrationWarning
      >
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
