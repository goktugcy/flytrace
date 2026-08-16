/**
 * The web app's Content-Security-Policy, built from runtime env so a deployment
 * can widen it without a rebuild. Kept out of `middleware.ts` so it is testable
 * — a source missing from a directive fails silently at runtime (the feature
 * just stops working, with only a console violation), so it needs a guard.
 */
import { buildCsp } from '@flytrace/shared/security';

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

function reportUri(apiUrl: string): string | undefined {
  const configured = process.env.CSP_REPORT_URI || DEFAULT_CSP_REPORT_PATH;
  if (/^https?:\/\//i.test(configured)) return configured;
  if (configured.startsWith('/')) return `${new URL(apiUrl).origin}${configured}`;
  return configured;
}

export function webCsp(nonce: string): string {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || DEFAULT_API_URL;
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL || deriveWsUrl(apiUrl);
  // Every style the app can load, not just the legacy single variable:
  // LiveMap picks _LIGHT or _DARK by theme, and a host missing from this
  // list is blocked by CSP — the map then renders blank with no error
  // beyond a console violation.
  const mapStyles = [
    process.env.NEXT_PUBLIC_MAP_STYLE,
    process.env.NEXT_PUBLIC_MAP_STYLE_LIGHT,
    process.env.NEXT_PUBLIC_MAP_STYLE_DARK,
  ].filter(Boolean);
  const mapOrigins = mapStyles.length
    ? [...new Set(mapStyles.flatMap((u) => originOf(u)))]
    : originOf(DEFAULT_MAP_STYLE);
  const turnstileEnabled =
    process.env.NEXT_PUBLIC_TURNSTILE_ENABLED === 'true' &&
    Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);
  const turnstileSources = turnstileEnabled ? [TURNSTILE_ORIGIN] : [];
  const devScriptSources = process.env.NODE_ENV === 'production' ? [] : ["'unsafe-eval'"];

  return buildCsp({
    connectSrc: [
      ...originOf(apiUrl),
      ...originOf(wsUrl),
      ...mapOrigins,
      // The weather overlay paints its colour field on a canvas and hands the
      // result to MapLibre as an `image` source. MapLibre only accepts a URL
      // there (4.x has no ImageData overload), so the canvas becomes a data:
      // URL that MapLibre then *fetches* — which connect-src governs, not
      // img-src. Without this the whole weather layer is dead in production.
      // Not an exfiltration path: a data: fetch never leaves the browser.
      'data:',
      ...csv(process.env.CSP_CONNECT_SRC),
      ...turnstileSources,
    ],
    imgSrc: [...mapOrigins, ...csv(process.env.CSP_IMG_SRC)],
    scriptSrc: [
      `'nonce-${nonce}'`,
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
