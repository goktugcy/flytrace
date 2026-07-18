import { OG_CONTENT_TYPE, OG_SIZE, renderOg } from '@/lib/og';

export const alt = 'FlyTrace — Live Flight Tracking';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default function Image() {
  return renderOg({
    title: 'Live Flight Tracking',
    subtitle: 'Watch real aircraft move in real time.',
  });
}
