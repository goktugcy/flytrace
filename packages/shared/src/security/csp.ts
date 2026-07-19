/**
 * Content Security Policy helpers shared by the API and Next.js web app.
 * Callers pass explicit source lists from env/runtime config; this module only
 * normalises and serialises directives.
 */

export interface CspOptions {
  /** Extra origins allowed for XHR/fetch/WebSocket (API, WS, tiles, analytics). */
  connectSrc?: string[] | undefined;
  /** Extra origins allowed for images beyond 'self' data: blob:. */
  imgSrc?: string[] | undefined;
  /** Extra origins or nonces allowed for scripts. */
  scriptSrc?: string[] | undefined;
  /** Extra origins or nonces allowed for styles. */
  styleSrc?: string[] | undefined;
  /** Extra origins allowed for fonts beyond 'self' data:. */
  fontSrc?: string[] | undefined;
  /** Extra origins allowed for iframes/frames (Turnstile). */
  frameSrc?: string[] | undefined;
  /** Additional/override directives, merged into the defaults. */
  extra?: Record<string, string[]> | undefined;
  /** Optional report-uri endpoint. */
  reportUri?: string | undefined;
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.trim().length > 0))];
}

/**
 * Build a CSP header value. Defaults deny broad fallback loads, block framing
 * and objects, and allow inline styles because Next/MapLibre still inject style
 * tags in this app. Script inlining can be controlled by passing a nonce source.
 */
export function buildCsp(opts: CspOptions = {}): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'base-uri': ["'self'"],
    'font-src': uniq(["'self'", 'data:', ...(opts.fontSrc ?? [])]),
    'img-src': uniq(["'self'", 'data:', 'blob:', ...(opts.imgSrc ?? [])]),
    'object-src': ["'none'"],
    'script-src': uniq(["'self'", ...(opts.scriptSrc ?? [])]),
    'style-src': uniq(["'self'", "'unsafe-inline'", ...(opts.styleSrc ?? [])]),
    'connect-src': uniq(["'self'", ...(opts.connectSrc ?? [])]),
    'frame-src': uniq(["'self'", ...(opts.frameSrc ?? [])]),
    'frame-ancestors': ["'none'"],
    'form-action': ["'self'"],
    'manifest-src': ["'self'"],
    'media-src': ["'self'", 'blob:'],
    'worker-src': ["'self'", 'blob:'],
  };
  if (opts.extra) {
    for (const [key, values] of Object.entries(opts.extra)) {
      directives[key] = uniq(values);
    }
  }
  const parts = Object.entries(directives).map(
    ([directive, values]) => `${directive} ${values.join(' ')}`,
  );
  if (opts.reportUri) parts.push(`report-uri ${opts.reportUri}`);
  return parts.join('; ');
}
