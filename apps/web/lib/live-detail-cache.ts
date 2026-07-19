import type { FlightDetail } from '@flytrace/shared/contracts';

const PREFIX = 'flytrace:live-flight-detail:';
const TTL_MS = 10 * 60 * 1000;

interface CachedDetail {
  cachedAt: number;
  detail: FlightDetail;
}

export function saveLiveFlightDetail(detail: FlightDetail): void {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.setItem(
      cacheKey(detail.flight.flightId),
      JSON.stringify({ cachedAt: Date.now(), detail }),
    );
  } catch {
    /* best-effort navigation fallback */
  }
}

export function readLiveFlightDetail(flightId: string): FlightDetail | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(cacheKey(flightId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedDetail;
    if (Date.now() - parsed.cachedAt > TTL_MS) {
      sessionStorage.removeItem(cacheKey(flightId));
      return null;
    }
    return isFlightDetail(parsed.detail, flightId) ? parsed.detail : null;
  } catch {
    return null;
  }
}

function cacheKey(flightId: string): string {
  return `${PREFIX}${flightId}`;
}

function isFlightDetail(value: unknown, flightId: string): value is FlightDetail {
  if (!value || typeof value !== 'object') return false;
  const detail = value as { flight?: unknown; live?: unknown; timeline?: unknown };
  if (!detail.flight || typeof detail.flight !== 'object') return false;
  const flight = detail.flight as { flightId?: unknown; callsign?: unknown };
  if (flight.flightId !== flightId || typeof flight.callsign !== 'string') return false;
  if (!Array.isArray(detail.timeline)) return false;
  if (detail.live !== null && (!detail.live || typeof detail.live !== 'object')) return false;
  return true;
}
