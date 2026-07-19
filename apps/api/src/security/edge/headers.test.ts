import { describe, expect, it } from 'bun:test';
import { buildCsp, secureHeadersConfig } from './headers.ts';

describe('buildCsp', () => {
  it('produces a locked-down default policy', () => {
    const csp = buildCsp();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("connect-src 'self'");
  });

  it('widens connect-src with API/WS origins', () => {
    const csp = buildCsp({ connectSrc: ['https://api.flytrace.app', 'wss://api.flytrace.app'] });
    expect(csp).toContain("connect-src 'self' https://api.flytrace.app wss://api.flytrace.app");
  });

  it('merges img-src extras and honours a report-uri', () => {
    const csp = buildCsp({ imgSrc: ['https://tiles.example'], reportUri: '/csp-report' });
    expect(csp).toContain('https://tiles.example');
    expect(csp).toContain('report-uri /csp-report');
  });

  it('lets extra directives override defaults', () => {
    const csp = buildCsp({ extra: { 'script-src': ["'self'", "'unsafe-eval'"] } });
    expect(csp).toContain("script-src 'self' 'unsafe-eval'");
  });
});

describe('secureHeadersConfig', () => {
  it('returns hardened defaults', () => {
    const cfg = secureHeadersConfig();
    expect(cfg.strictTransportSecurity).toContain('includeSubDomains');
    expect(cfg.xFrameOptions).toBe('DENY');
    expect(cfg.xContentTypeOptions).toBe('nosniff');
    expect(cfg.referrerPolicy).toBe('strict-origin-when-cross-origin');
    expect(cfg.contentSecurityPolicy).toBeUndefined();
  });

  it('honours a custom HSTS max-age and attaches CSP when provided', () => {
    const cfg = secureHeadersConfig({ hstsMaxAgeSec: 60, csp: buildCsp() });
    expect(cfg.strictTransportSecurity).toBe('max-age=60; includeSubDomains');
    expect(cfg.contentSecurityPolicy).toContain("default-src 'self'");
  });
});
