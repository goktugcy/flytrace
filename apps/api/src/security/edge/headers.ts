import { type CspOptions, buildCsp } from '@flytrace/shared';

export { buildCsp, type CspOptions };

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
