import Link from 'next/link';

export default function HomePage() {
  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '4rem 1.5rem' }}>
      <h1 style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>FlyTrace</h1>
      <p style={{ color: 'var(--muted)', fontSize: '1.15rem', lineHeight: 1.5 }}>
        Watch real aircraft move in real time, with derived takeoff, landing, and descent events.
        Positions via the OpenSky Network.
      </p>
      <p style={{ marginTop: '2rem' }}>
        <Link
          href="/map"
          style={{
            display: 'inline-block',
            padding: '0.75rem 1.5rem',
            borderRadius: 8,
            background: 'var(--accent)',
            color: '#04122b',
            fontWeight: 600,
            textDecoration: 'none',
          }}
        >
          Open the live map →
        </Link>
      </p>
    </main>
  );
}
