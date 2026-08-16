import { webCsp } from '@/lib/csp';
import { type NextRequest, NextResponse } from 'next/server';

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
