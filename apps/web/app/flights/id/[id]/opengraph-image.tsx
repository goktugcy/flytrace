import { OG_CONTENT_TYPE, OG_SIZE, renderOg } from '@/lib/og';

export const alt = 'Flight — FlyTrace';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

// Server-side base: NEXT_PUBLIC_API_URL if pinned, else the local API.
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let title = 'Flight';
  let subtitle = 'Live tracking';
  try {
    const res = await fetch(`${API}/api/v1/flights/id/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(2500),
    });
    if (res.ok) {
      const flight = (
        (await res.json()) as { data?: { flight?: { callsign?: string; status?: string } } }
      ).data?.flight;
      if (flight?.callsign) title = flight.callsign;
      if (flight?.status) subtitle = `Status: ${flight.status}`;
    }
  } catch {
    /* best-effort — fall back to the generic card */
  }
  return renderOg({ badge: 'Live Flight', title, subtitle });
}
