import { OG_CONTENT_TYPE, OG_SIZE, renderOg } from '@/lib/og';

export const alt = 'Aircraft — FlyTrace';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default async function Image({ params }: { params: Promise<{ registration: string }> }) {
  const { registration } = await params;
  return renderOg({
    badge: 'Aircraft',
    title: registration.toUpperCase(),
    subtitle: 'History & utilization',
  });
}
