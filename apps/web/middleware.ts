import { buildCsp } from '@flytrace/shared/security';
import { type NextRequest, NextResponse } from 'next/server';

const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
const DEFAULT_API_URL = 'http://localhost:3001';
const DEFAULT_MAP_STYLE = 'https://tiles.openfreemap.org/styles/dark';
const DEFAULT_CSP_REPORT_PATH = '/api/v1/security/csp-report';

function csv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function originOf(value: string | undefined): string[] {
  if (!value) return [];
  try {
    return [new URL(value).origin];
  } catch {
    return [];
  }
}

function deriveWsUrl(apiUrl: string): string {
  return apiUrl.replace(/^http/, 'ws');
}

function nonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

function cspHeaderName(mode: string | undefined): string | null {
  if (mode === 'report-only') return 'Content-Security-Policy-Report-Only';
  if (mode === 'enforce') return 'Content-Security-Policy';
  return null;
}

function reportUri(apiUrl: string): string | undefined {
  const configured = process.env.CSP_REPORT_URI || DEFAULT_CSP_REPORT_PATH;
  if (/^https?:\/\//i.test(configured)) return configured;
  if (configured.startsWith('/')) return `${new URL(apiUrl).origin}${configured}`;
  return configured;
}

function webCsp(n: string): string {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_URL;
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL || deriveWsUrl(apiUrl);
  const mapStyle = process.env.NEXT_PUBLIC_MAP_STYLE || DEFAULT_MAP_STYLE;
  const turnstileEnabled =
    process.env.NEXT_PUBLIC_TURNSTILE_ENABLED === 'true' &&
    Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);
  const turnstileSources = turnstileEnabled ? [TURNSTILE_ORIGIN] : [];
  const devScriptSources = process.env.NODE_ENV === 'production' ? [] : ["'unsafe-eval'"];

  return buildCsp({
    connectSrc: [
      ...originOf(apiUrl),
      ...originOf(wsUrl),
      ...originOf(mapStyle),
      ...csv(process.env.CSP_CONNECT_SRC),
      ...turnstileSources,
    ],
    imgSrc: [...originOf(mapStyle), ...csv(process.env.CSP_IMG_SRC)],
    scriptSrc: [
      `'nonce-${n}'`,
      ...devScriptSources,
      ...csv(process.env.CSP_SCRIPT_SRC),
      ...turnstileSources,
    ],
    styleSrc: csv(process.env.CSP_STYLE_SRC),
    fontSrc: csv(process.env.CSP_FONT_SRC),
    frameSrc: [...csv(process.env.CSP_FRAME_SRC), ...turnstileSources],
    reportUri: reportUri(apiUrl),
  });
}

export function middleware(req: NextRequest) {
  const headerName = cspHeaderName(process.env.CSP_MODE);
  if (!headerName) return NextResponse.next();

  const n = nonce();
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', n);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set(headerName, webCsp(n));
  res.headers.set('x-nonce', n);
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest|sw.js).*)'],
};
