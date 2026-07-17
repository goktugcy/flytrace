import type { TicketPayload } from './ticket.ts';

/**
 * Subscription channels (docs/12 §12.3). `viewport` is handled out-of-band via
 * the `viewport` message (one per connection), so it is not a named channel
 * here. Flight/airport are public; `user:<id>` and `admin:*` are authorized.
 */
export type Channel =
  | { kind: 'flight'; flightId: string; raw: string }
  | { kind: 'airport'; iata: string; raw: string }
  | { kind: 'user'; userId: string; raw: string }
  | { kind: 'admin'; raw: string };

export function parseChannel(raw: string): Channel | null {
  const [kind, rest] = splitFirst(raw, ':');
  switch (kind) {
    case 'flight':
      return rest ? { kind: 'flight', flightId: rest, raw } : null;
    case 'airport':
      return rest ? { kind: 'airport', iata: rest.toUpperCase(), raw } : null;
    case 'user':
      return rest ? { kind: 'user', userId: rest, raw } : null;
    case 'admin':
      return rest === 'metrics' ? { kind: 'admin', raw } : null;
    default:
      return null;
  }
}

/** Server-side channel authorization against the connection's ticket. */
export function authorizeChannel(channel: Channel, ticket: TicketPayload): boolean {
  switch (channel.kind) {
    case 'flight':
    case 'airport':
      return true; // public
    case 'user':
      return ticket.uid !== null && ticket.uid === channel.userId;
    case 'admin':
      return ticket.role === 'admin';
  }
}

export type Bbox = readonly [west: number, south: number, east: number, north: number];

/** Point-in-bbox test. Handles the antimeridian case (west > east). */
export function inBbox(lat: number, lon: number, [w, s, e, n]: Bbox): boolean {
  if (lat < s || lat > n) return false;
  return w <= e ? lon >= w && lon <= e : lon >= w || lon <= e;
}

function splitFirst(s: string, sep: string): [string, string | null] {
  const i = s.indexOf(sep);
  return i === -1 ? [s, null] : [s.slice(0, i), s.slice(i + 1)];
}
