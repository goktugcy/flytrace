import { OG_CONTENT_TYPE, OG_SIZE, renderOg } from '@/lib/og';

export const alt = 'Airport — FlyTrace';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default async function Image({ params }: { params: Promise<{ iata: string }> }) {
  const { iata } = await params;
  return renderOg({
    badge: 'Airport',
    title: iata.toUpperCase(),
    subtitle: 'Live arrivals & departures',
  });
}
