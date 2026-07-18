/**
 * Base URL of the API. Prefers NEXT_PUBLIC_API_URL when explicitly set;
 * otherwise derives it from the page's own hostname (port 3001) so the app
 * works over localhost AND from a LAN address — e.g. a phone hitting
 * 192.168.x.x:3000 must reach the API at 192.168.x.x:3001, not its own
 * localhost. SSR falls back to localhost (fetches run client-side, so the
 * browser-evaluated value is what actually gets used).
 */
export function apiBase(): string {
  const env = process.env.NEXT_PUBLIC_API_URL;
  if (env) return env;
  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:3001`;
  }
  return 'http://localhost:3001';
}

/** WebSocket base derived from {@link apiBase} (http→ws, https→wss). */
export function wsBase(): string {
  return apiBase().replace(/^http/, 'ws');
}
