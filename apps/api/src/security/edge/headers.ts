/**
 * Pure builders for security response headers. `buildCsp` produces a
 * Content-Security-Policy string with a locked-down `default-src 'self'` policy
 * whose `connect-src` is configurable for the API/WebSocket origins the web app
 * talks to. `secureHeadersConfig` returns a plain options object (HSTS, frame,
 * referrer, …) suitable for feeding hono/secure-headers. No I/O, fully testable.
 */

export interface CspOptions {
  /** Extra origins allowed for XHR/fetch/WebSocket (API + WS URLs). */
  connectSrc?: string[] | undefined;
  /** Extra origins allowed for <img> beyond 'self' data: blob:. */
  imgSrc?: string[] | undefined;
  /** Additional/override directives, merged into the defaults. */
  extra?: Record<string, string[]> | undefined;
  /** Optional report-uri endpoint. */
  reportUri?: string | undefined;
}

/**
 * Build a CSP header value. Defaults deny everything except same-origin, block
 * framing/objects, and allow inline styles (needed by most CSS-in-JS). Callers
 * widen `connect-src`/`img-src` for their API and WS endpoints.
 */
export function buildCsp(opts: CspOptions = {}): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'base-uri': ["'self'"],
    'font-src': ["'self'", 'data:'],
    'img-src': ["'self'", 'data:', 'blob:', ...(opts.imgSrc ?? [])],
    'object-src': ["'none'"],
    'script-src': ["'self'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'connect-src': ["'self'", ...(opts.connectSrc ?? [])],
    'frame-ancestors': ["'none'"],
    'form-action': ["'self'"],
  };
  if (opts.extra) {
    for (const [key, values] of Object.entries(opts.extra)) {
      directives[key] = values;
    }
  }
  const parts = Object.entries(directives).map(
    ([directive, values]) => `${directive} ${values.join(' ')}`,
  );
  if (opts.reportUri) parts.push(`report-uri ${opts.reportUri}`);
  return parts.join('; ');
}

export interface SecureHeadersConfig {
  strictTransportSecurity: string;
  xFrameOptions: string;
  xContentTypeOptions: string;
  referrerPolicy: string;
  crossOriginOpenerPolicy: string;
  crossOriginResourcePolicy: string;
  contentSecurityPolicy?: string;
}

export interface SecureHeadersOptions {
  /** Prebuilt CSP string (see {@link buildCsp}); omitted → no CSP header. */
  csp?: string | undefined;
  /** HSTS max-age in seconds (default 180 days). */
  hstsMaxAgeSec?: number | undefined;
}

/**
 * Return a hardened set of security-header options: HSTS (includeSubDomains),
 * `DENY` framing, nosniff, a privacy-preserving referrer policy, and
 * cross-origin isolation. Attach the CSP only when one is provided.
 */
export function secureHeadersConfig(opts: SecureHeadersOptions = {}): SecureHeadersConfig {
  const maxAge = opts.hstsMaxAgeSec ?? 15_552_000; // 180 days
  return {
    strictTransportSecurity: `max-age=${maxAge}; includeSubDomains`,
    xFrameOptions: 'DENY',
    xContentTypeOptions: 'nosniff',
    referrerPolicy: 'strict-origin-when-cross-origin',
    crossOriginOpenerPolicy: 'same-origin',
    crossOriginResourcePolicy: 'same-origin',
    ...(opts.csp ? { contentSecurityPolicy: opts.csp } : {}),
  };
}
