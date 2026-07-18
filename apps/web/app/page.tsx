import { Hero } from '@/components/Hero';
import { LiveCounters } from '@/components/LiveCounters';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ArrowRight, Bell, ChevronDown, PlaneTakeoff, Radio, Satellite } from 'lucide-react';
import Link from 'next/link';

const FEATURES = [
  {
    icon: Satellite,
    title: 'Real-time positions',
    body: 'Aircraft glide across the map, updated every few seconds from the OpenSky Network.',
  },
  {
    icon: PlaneTakeoff,
    title: 'Derived events',
    body: 'Takeoff, climb, top-of-descent and landing — detected from the raw track, on a timeline.',
  },
  {
    icon: Bell,
    title: 'Watch & get pinged',
    body: 'Watch a flight and get a Web Push, Telegram, or email alert the moment something happens.',
  },
  {
    icon: Radio,
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
    <main className="mx-auto max-w-6xl px-4 sm:px-6">
      {/* Hero */}
      <section className="grid items-center gap-10 py-16 sm:py-24 lg:grid-cols-2 lg:gap-12">
        <div>
          <Badge variant="accent" className="mb-5">
            <span className="relative flex size-1.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent-bright opacity-75" />
              <span className="relative inline-flex size-1.5 rounded-full bg-accent-bright" />
            </span>
            Live · OpenSky Network
          </Badge>
          <h1 className="text-balance text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl">
            Watch the sky, <span className="text-accent-bright">live</span>.
          </h1>
          <p className="mt-5 max-w-xl text-pretty text-lg leading-relaxed text-muted-foreground">
            Real aircraft, moving in real time — with takeoff, landing and descent events derived
            from the track, and alerts on the channel you choose.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link href="/map">
                Open the live map
                <ArrowRight />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/signin">Create account</Link>
            </Button>
          </div>
          <LiveCounters />
        </div>

        <Hero />
      </section>

      {/* Features */}
      <section className="py-8">
        <h2 className="text-2xl font-semibold tracking-tight">What you get</h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {FEATURES.map((f) => (
            <Card
              key={f.title}
              className="transition-colors hover:border-border/60 hover:bg-accent/40"
            >
              <CardContent className="p-6">
                <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-accent-bright">
                  <f.icon className="size-5" />
                </div>
                <h3 className="mt-4 font-medium">{f.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section className="py-16">
        <h2 className="text-2xl font-semibold tracking-tight">Frequently asked</h2>
        <div className="mt-6 divide-y divide-border rounded-xl border border-border bg-card">
          {FAQ.map((item) => (
            <details key={item.q} className="group px-5 [&_summary]:list-none">
              <summary className="flex cursor-pointer items-center justify-between py-4 font-medium">
                {item.q}
                <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
              </summary>
              <p className="pb-4 text-sm leading-relaxed text-muted-foreground">{item.a}</p>
            </details>
          ))}
        </div>
      </section>

      <footer className="border-t border-border py-8 text-sm text-muted-foreground">
        Positions © OpenSky Network · Map © MapLibre · FlyTrace
      </footer>
    </main>
  );
}
