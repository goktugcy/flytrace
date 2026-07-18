import { ImageResponse } from 'next/og';

/**
 * Shared Open Graph / social-card renderer. Next auto-wires each route's
 * `opengraph-image` file into that page's metadata; these helpers keep the
 * brand treatment (dark canvas, sky-blue accent, wordmark) identical across
 * landing, flight, airport and aircraft cards.
 */
export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = 'image/png';

interface OgOptions {
  /** Small uppercase eyebrow, e.g. "Live Flight" / "Airport". */
  badge?: string;
  title: string;
  subtitle?: string;
}

export function renderOg({ badge, title, subtitle }: OgOptions): ImageResponse {
  return new ImageResponse(
    <div
      style={{
        height: '100%',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: '#0a0e1a',
        backgroundImage:
          'radial-gradient(circle at 18% 15%, rgba(56,189,248,0.20), transparent 42%), radial-gradient(circle at 90% 95%, rgba(56,189,248,0.10), transparent 40%)',
        padding: '72px',
        color: '#e2e8f0',
        fontFamily: 'sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '18px' }}>
        <div
          style={{
            display: 'flex',
            width: '56px',
            height: '56px',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '14px',
            background: '#38bdf8',
          }}
        >
          <svg
            width="32"
            height="32"
            viewBox="0 0 24 24"
            fill="#0a0e1a"
            role="img"
            aria-label="FlyTrace"
          >
            <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" />
          </svg>
        </div>
        <span style={{ fontSize: '30px', fontWeight: 700, letterSpacing: '-0.5px' }}>FlyTrace</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {badge ? (
          <span
            style={{
              fontSize: '22px',
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '4px',
              color: '#38bdf8',
            }}
          >
            {badge}
          </span>
        ) : null}
        <span
          style={{
            fontSize: '86px',
            fontWeight: 800,
            lineHeight: 1.04,
            letterSpacing: '-3px',
            color: '#f8fafc',
          }}
        >
          {title}
        </span>
        {subtitle ? <span style={{ fontSize: '34px', color: '#94a3b8' }}>{subtitle}</span> : null}
      </div>

      <span style={{ fontSize: '24px', color: '#64748b' }}>Real-time flight tracking</span>
    </div>,
    OG_SIZE,
  );
}
