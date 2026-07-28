'use client';

import { ArchitecturePipeline } from '@/components/ArchitecturePipeline';
import { HeroFlights } from '@/components/HeroFlights';
import { LiveCounters } from '@/components/LiveCounters';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { apiBase } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { ArrowRight, Bell, ChevronDown, PlaneTakeoff, Radio, Satellite } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

const API_BASE = apiBase();

const FEATURES = [
  { icon: Satellite, key: 'f1' },
  { icon: PlaneTakeoff, key: 'f2' },
  { icon: Bell, key: 'f3' },
  { icon: Radio, key: 'f4' },
];
const FAQ = ['q1', 'q2', 'q3'];

export default function HomePage() {
  const t = useT();
  // Auth-aware CTAs: signed-in visitors get a dashboard shortcut instead of the
  // "create account" prompt. null = still checking (render only the map CTA).
  const [authed, setAuthed] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/auth/session`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setAuthed(Boolean(d?.data?.user));
      })
      .catch(() => {
        if (!cancelled) setAuthed(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <main className="mx-auto max-w-6xl px-4 sm:px-6">
      {/* Hero */}
      <section className="relative overflow-hidden py-20 sm:py-28">
        {/* Aircraft drift across the whole hero (transparent, frameless) */}
        <HeroFlights />
        <div className="relative z-10 max-w-2xl">
          <Badge variant="accent" className="mb-5">
            <span className="relative flex size-1.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent-bright opacity-75" />
              <span className="relative inline-flex size-1.5 rounded-full bg-accent-bright" />
            </span>
            {t('landing.badge')}
          </Badge>
          <h1 className="text-balance text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl">
            {t('landing.title.pre')}
            <span className="text-accent-bright">{t('landing.title.em')}</span>.
          </h1>
          <p className="mt-5 max-w-xl text-pretty text-lg leading-relaxed text-muted-foreground">
            {t('landing.subtitle')}
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link href="/map">
                {t('landing.cta.map')}
                <ArrowRight />
              </Link>
            </Button>
            {authed === true && (
              <Button asChild size="lg" variant="outline">
                <Link href="/dashboard">{t('landing.cta.dashboard')}</Link>
              </Button>
            )}
            {authed === false && (
              <Button asChild size="lg" variant="outline">
                <Link href="/signin">{t('landing.cta.account')}</Link>
              </Button>
            )}
          </div>
          <LiveCounters />
        </div>
      </section>

      {/* Architecture — how the real pipeline works */}
      <ArchitecturePipeline />

      {/* Features */}
      <section className="py-8">
        <h2 className="text-2xl font-semibold tracking-tight">{t('landing.features.title')}</h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {FEATURES.map((f) => (
            <Card
              key={f.key}
              className="transition-colors hover:border-border/60 hover:bg-accent/40"
            >
              <CardContent className="p-6">
                <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-accent-bright">
                  <f.icon className="size-5" />
                </div>
                <h3 className="mt-4 font-medium">{t(`landing.${f.key}.title`)}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                  {t(`landing.${f.key}.body`)}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section className="py-16">
        <h2 className="text-2xl font-semibold tracking-tight">{t('landing.faq.title')}</h2>
        <div className="mt-6 divide-y divide-border rounded-xl border border-border bg-card">
          {FAQ.map((q) => (
            <details key={q} className="group px-5 [&_summary]:list-none">
              <summary className="flex cursor-pointer items-center justify-between py-4 font-medium">
                {t(`landing.faq.${q}`)}
                <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
              </summary>
              <p className="pb-4 text-sm leading-relaxed text-muted-foreground">
                {t(`landing.faq.${q.replace('q', 'a')}`)}
              </p>
            </details>
          ))}
        </div>
      </section>

      <footer className="border-t border-border py-8 text-sm text-muted-foreground">
        Positions © ADS-B · Map © MapLibre / OpenFreeMap · FlyTrace
      </footer>
    </main>
  );
}
