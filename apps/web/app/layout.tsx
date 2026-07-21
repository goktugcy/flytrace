import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { CommandPalette } from '../components/CommandPalette';
import { ServiceWorker } from '../components/ServiceWorker';
import { SiteHeader } from '../components/site-header';
import { I18nProvider, LOCALE_COOKIE, type Locale } from '../lib/i18n';
import './globals.css';

// Absolute base for OG/canonical URLs so social cards resolve the per-route
// opengraph-image files Next generates.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
const TITLE = 'FlyTrace — Live Flight Tracking';
const DESCRIPTION = 'Watch real aircraft move in real time.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg' },
  openGraph: { type: 'website', siteName: 'FlyTrace', title: TITLE, description: DESCRIPTION },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#09090b' },
  ],
};

const THEME_COOKIE = 'flytrace.theme';

// Runs before first paint: applies the saved theme (cookie/localStorage) or the
// OS preference, so there's no flash of the wrong theme and no hydration flip.
const THEME_INIT = `(function(){try{var m=document.cookie.match(/flytrace\\.theme=(light|dark|system)/);var t=m?m[1]:(localStorage.getItem('flytrace.theme')||'system');var d=t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);document.documentElement.style.colorScheme=d?'dark':'light';}catch(e){}})();`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  const locale: Locale = jar.get(LOCALE_COOKIE)?.value === 'tr' ? 'tr' : 'en';
  const theme = jar.get(THEME_COOKIE)?.value;
  // Commit a class server-side only when the user has an explicit choice; for
  // "system"/first-visit the inline script decides (avoids a wrong-theme flash).
  const htmlClass = theme === 'dark' ? 'dark' : undefined;
  return (
    // suppressHydrationWarning: the theme class is set by the pre-paint script
    // above (and browser extensions touch <html>/<body>); the app markup itself
    // is SSR-correct. Suppresses attribute noise on these two elements only.
    <html lang={locale} className={htmlClass} suppressHydrationWarning>
      <body
        className="min-h-dvh bg-background text-foreground antialiased"
        suppressHydrationWarning
      >
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static, self-authored no-flash theme bootstrap */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
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
