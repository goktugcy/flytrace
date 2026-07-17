import Link from 'next/link';
import { Hero } from '../components/Hero';
import { LiveCounters } from '../components/LiveCounters';

const FEATURES = [
  {
    icon: '🛰️',
    title: 'Real-time positions',
    body: 'Aircraft glide across the map, updated every few seconds from the OpenSky Network.',
  },
  {
    icon: '✈️',
    title: 'Derived events',
    body: 'Takeoff, climb, top-of-descent and landing — detected from the raw track, on a timeline.',
  },
  {
    icon: '🔔',
    title: 'Watch & get pinged',
    body: 'Watch a flight and get a Web Push, Telegram, or email alert the moment something happens.',
  },
  {
    icon: '🛫',
    title: 'Provider status',
    body: 'Gate changes, delays and cancellations from airline sources, layered on top of positions.',
  },
];

const FAQ = [
  {
    q: 'Where does the data come from?',
    a: 'Live positions are from the OpenSky Network. Flight status (gate, delay) comes from compliant public airline sources where available.',
  },
  {
    q: 'Is it free?',
    a: 'Watching flights and the live map are free. Create an account to save watches and get notifications.',
  },
  {
    q: 'How fast are updates?',
    a: 'Positions arrive every 1–5 seconds and are pushed to your browser over WebSocket, interpolated for smooth motion.',
  },
];

export default function HomePage() {
  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: '4rem 1.5rem' }}>
      <section>
        <h1 style={{ fontSize: '3rem', lineHeight: 1.05, margin: 0, letterSpacing: '-0.02em' }}>
          Watch the sky, <span style={{ color: 'var(--accent)' }}>live</span>.
        </h1>
        <p
          style={{
            color: 'var(--muted)',
            fontSize: '1.2rem',
            lineHeight: 1.5,
            maxWidth: 620,
            marginTop: '1rem',
          }}
        >
          Real aircraft, moving in real time — with takeoff, landing and descent events derived from
          the track, and alerts on the channel you choose.
        </p>
        <div style={{ display: 'flex', gap: 12, marginTop: '1.75rem', flexWrap: 'wrap' }}>
          <Cta href="/map" primary>
            Open the live map →
          </Cta>
          <Cta href="/signin">Create account</Cta>
        </div>
        <LiveCounters />
        <Hero />
      </section>

      <h2 style={{ fontSize: '1.5rem', marginTop: '4rem', marginBottom: 0 }}>What you get</h2>
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))',
          gap: 16,
          marginTop: '1.25rem',
        }}
      >
        {FEATURES.map((f) => (
          <div
            key={f.title}
            style={{ background: 'var(--panel)', borderRadius: 12, padding: '1.25rem' }}
          >
            <div style={{ fontSize: 28 }}>{f.icon}</div>
            <h3 style={{ margin: '0.5rem 0 0.35rem', fontSize: '1.05rem' }}>{f.title}</h3>
            <p style={{ color: 'var(--muted)', margin: 0, fontSize: 14, lineHeight: 1.5 }}>
              {f.body}
            </p>
          </div>
        ))}
      </section>

      <section style={{ marginTop: '4rem' }}>
        <h2 style={{ fontSize: '1.5rem' }}>FAQ</h2>
        {FAQ.map((item) => (
          <details key={item.q} style={{ borderBottom: '1px solid #1e2636', padding: '0.9rem 0' }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{item.q}</summary>
            <p style={{ color: 'var(--muted)', margin: '0.5rem 0 0', lineHeight: 1.5 }}>{item.a}</p>
          </details>
        ))}
      </section>

      <footer style={{ marginTop: '4rem', color: 'var(--muted)', fontSize: 13 }}>
        Positions © OpenSky Network · Map © MapLibre · FlyTrace
      </footer>
    </main>
  );
}

function Cta({
  href,
  children,
  primary,
}: { href: string; children: React.ReactNode; primary?: boolean }) {
  return (
    <Link
      href={href}
      style={{
        display: 'inline-block',
        padding: '0.75rem 1.5rem',
        borderRadius: 8,
        fontWeight: 600,
        textDecoration: 'none',
        background: primary ? 'var(--accent)' : 'transparent',
        color: primary ? '#04122b' : 'var(--fg)',
        border: primary ? 'none' : '1px solid #2a3446',
      }}
    >
      {children}
    </Link>
  );
}
