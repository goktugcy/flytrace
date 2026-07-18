/**
 * Search → map bridge. A search result should locate the aircraft on the live
 * map (fly to it + select it), not open a detail page. When the map is already
 * mounted it consumes the focus in place; otherwise the caller navigates to
 * /map with the target encoded in the query string and the map picks it up on
 * mount (see readFocusFromUrl).
 */
export interface FocusTarget {
  flightId: string;
  icao24: string | null;
  callsign: string | null;
  lat: number | null;
  lon: number | null;
}

let handler: ((t: FocusTarget) => void) | null = null;

/** Called by the mounted map to receive focus requests. Returns an unsubscribe. */
export function registerMapFocus(fn: (t: FocusTarget) => void): () => void {
  handler = fn;
  return () => {
    if (handler === fn) handler = null;
  };
}

/** Focus in place if the map is mounted. Returns true if consumed. */
export function tryFocus(t: FocusTarget): boolean {
  if (!handler) return false;
  handler(t);
  return true;
}

/** Encode a target as /map query params for the navigate-then-focus path. */
export function focusQuery(t: FocusTarget): string {
  const p = new URLSearchParams({ sel: t.flightId });
  if (t.icao24) p.set('hex', t.icao24);
  if (t.callsign) p.set('cs', t.callsign);
  if (t.lat != null) p.set('lat', String(t.lat));
  if (t.lon != null) p.set('lon', String(t.lon));
  return p.toString();
}

/** Parse a focus target the map should apply on mount, or null. */
export function readFocusFromUrl(search: string): FocusTarget | null {
  const p = new URLSearchParams(search);
  const flightId = p.get('sel');
  if (!flightId) return null;
  const lat = p.get('lat');
  const lon = p.get('lon');
  return {
    flightId,
    icao24: p.get('hex'),
    callsign: p.get('cs'),
    lat: lat != null ? Number(lat) : null,
    lon: lon != null ? Number(lon) : null,
  };
}
