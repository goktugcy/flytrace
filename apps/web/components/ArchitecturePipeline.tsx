'use client';

import { useT } from '@/lib/i18n';
import {
  ChevronDown,
  ChevronRight,
  Database,
  GitMerge,
  MapPinned,
  Radio,
  Satellite,
} from 'lucide-react';
import { Fragment } from 'react';

const STAGES = [
  { key: 's1', icon: Satellite },
  { key: 's2', icon: GitMerge },
  { key: 's3', icon: Radio },
  { key: 's4', icon: Database },
  { key: 's5', icon: MapPinned },
] as const;

/**
 * Landing "how it works" pipeline — the real FlyTrace data flow from open ADS-B
 * sources through the fusion tracker, real-time core and PostGIS engine to the
 * live MapLibre map. Horizontal on desktop, stacked on mobile.
 */
export function ArchitecturePipeline() {
  const t = useT();
  return (
    <section className="py-8">
      <h2 className="text-2xl font-semibold tracking-tight">{t('landing.arch.title')}</h2>
      <p className="mt-2 max-w-2xl text-pretty leading-relaxed text-muted-foreground">
        {t('landing.arch.subtitle')}
      </p>

      <ol className="mt-8 flex flex-col items-stretch gap-2 lg:flex-row lg:gap-0">
        {STAGES.map((s, i) => (
          <Fragment key={s.key}>
            <li className="group relative flex-1 overflow-hidden rounded-xl border border-border bg-card p-5 transition-colors hover:border-border/60 hover:bg-accent/40">
              <span className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent-bright/60 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
              <div className="flex items-center justify-between">
                <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-accent-bright">
                  <s.icon className="size-5" />
                </span>
                <span className="font-mono text-xs text-muted-foreground/70">
                  {String(i + 1).padStart(2, '0')}
                </span>
              </div>
              <h3 className="mt-4 font-medium">{t(`landing.arch.${s.key}.title`)}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                {t(`landing.arch.${s.key}.body`)}
              </p>
            </li>
            {i < STAGES.length - 1 && (
              <span
                aria-hidden="true"
                className="flex items-center justify-center self-center text-muted-foreground/50 lg:px-1"
              >
                <ChevronDown className="size-4 lg:hidden" />
                <ChevronRight className="hidden size-4 lg:block" />
              </span>
            )}
          </Fragment>
        ))}
      </ol>
    </section>
  );
}
