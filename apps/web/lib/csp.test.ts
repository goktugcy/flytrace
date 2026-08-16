import { afterEach, describe, expect, test } from 'bun:test';
import { webCsp } from './csp.ts';

const KEYS = [
  'NEXT_PUBLIC_API_URL',
  'NEXT_PUBLIC_WS_URL',
  'NEXT_PUBLIC_MAP_STYLE',
  'NEXT_PUBLIC_MAP_STYLE_LIGHT',
  'NEXT_PUBLIC_MAP_STYLE_DARK',
  'NEXT_PUBLIC_TURNSTILE_ENABLED',
  'NEXT_PUBLIC_TURNSTILE_SITE_KEY',
  'CSP_CONNECT_SRC',
  'CSP_IMG_SRC',
  'CSP_REPORT_URI',
];
const saved = new Map(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
});

/** Read one directive's source list out of the serialised header. */
function directive(csp: string, name: string): string[] {
  const part = csp.split(';').find((p) => p.trim().startsWith(`${name} `));
  return (part ?? '').trim().split(/\s+/).slice(1);
}

describe('webCsp', () => {
  test('allows the map style origin for both fetching and drawing', () => {
    process.env.NEXT_PUBLIC_MAP_STYLE_LIGHT = 'https://tiles.example.org/styles/light';
    process.env.NEXT_PUBLIC_MAP_STYLE_DARK = 'https://tiles.example.org/styles/dark';
    const csp = webCsp('n1');
    // Style JSON + glyphs go through fetch; the tiles themselves are images.
    expect(directive(csp, 'connect-src')).toContain('https://tiles.example.org');
    expect(directive(csp, 'img-src')).toContain('https://tiles.example.org');
  });

  test('allows data: in connect-src for the weather overlay', () => {
    // The overlay hands MapLibre a canvas as a data: URL, which MapLibre
    // fetches. Dropping this source silently disables the whole weather layer.
    expect(directive(webCsp('n1'), 'connect-src')).toContain('data:');
  });

  test('carries the request nonce into script-src and never allows inline scripts', () => {
    const csp = webCsp('abc123');
    expect(directive(csp, 'script-src')).toContain("'nonce-abc123'");
    expect(directive(csp, 'script-src')).not.toContain("'unsafe-inline'");
  });

  test('omits Turnstile sources unless it is both enabled and keyed', () => {
    process.env.NEXT_PUBLIC_TURNSTILE_ENABLED = 'true';
    Reflect.deleteProperty(process.env, 'NEXT_PUBLIC_TURNSTILE_SITE_KEY');
    expect(webCsp('n1')).not.toContain('challenges.cloudflare.com');

    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = 'site-key';
    const csp = webCsp('n1');
    expect(directive(csp, 'frame-src')).toContain('https://challenges.cloudflare.com');
    expect(directive(csp, 'script-src')).toContain('https://challenges.cloudflare.com');
  });

  test('widens each directive from its env override', () => {
    process.env.CSP_CONNECT_SRC = 'https://a.example, https://b.example';
    process.env.CSP_IMG_SRC = 'https://img.example';
    const csp = webCsp('n1');
    expect(directive(csp, 'connect-src')).toContain('https://a.example');
    expect(directive(csp, 'connect-src')).toContain('https://b.example');
    expect(directive(csp, 'img-src')).toContain('https://img.example');
  });

  test('resolves a relative report path against the API origin', () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.example.org';
    process.env.CSP_REPORT_URI = '/csp';
    expect(webCsp('n1')).toContain('report-uri https://api.example.org/csp');
  });
});
