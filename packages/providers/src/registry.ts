import type { FlightProvider, ProviderContext, ProviderFactory, ProviderHealth } from './types.ts';

export interface RegistryBuildOptions {
  /** Provider keys enabled via the `providers` table / settings (docs/08 §8.6). */
  enabled: Set<string>;
  /** Per-key priority for airline-IATA conflicts (higher wins). */
  priority?: Record<string, number>;
  ctx: ProviderContext;
}

/**
 * Maps `airlineIata → provider` from the statically-registered factories,
 * activating only those enabled by config (docs/08 §8.6). Core code calls
 * `registry.forAirline("TK")`, never `new THYProvider()`.
 */
export class ProviderRegistry {
  private readonly byKey = new Map<string, FlightProvider>();
  private readonly byAirline = new Map<string, FlightProvider>();

  private constructor() {}

  static async build(
    factories: ProviderFactory[],
    opts: RegistryBuildOptions,
  ): Promise<ProviderRegistry> {
    const reg = new ProviderRegistry();
    for (const factory of factories) {
      if (!opts.enabled.has(factory.key)) continue;
      const provider = factory.create();
      await provider.init(opts.ctx);
      reg.byKey.set(provider.key, provider);
      for (const iata of provider.airlineIata) {
        reg.assignAirline(iata.toUpperCase(), provider, opts);
      }
    }
    return reg;
  }

  private assignAirline(iata: string, provider: FlightProvider, opts: RegistryBuildOptions): void {
    const existing = this.byAirline.get(iata);
    if (!existing) {
      this.byAirline.set(iata, provider);
      return;
    }
    const pe = opts.priority?.[existing.key] ?? 0;
    const pn = opts.priority?.[provider.key] ?? 0;
    if (pn > pe) {
      this.byAirline.set(iata, provider);
    } else {
      opts.ctx.logger.warn('provider iata conflict', {
        iata,
        kept: existing.key,
        dropped: provider.key,
      });
    }
  }

  forAirline(iata: string): FlightProvider | null {
    return this.byAirline.get(iata.toUpperCase()) ?? null;
  }

  get(key: string): FlightProvider | null {
    return this.byKey.get(key) ?? null;
  }

  all(): FlightProvider[] {
    return [...this.byKey.values()];
  }

  async health(): Promise<Record<string, ProviderHealth>> {
    const out: Record<string, ProviderHealth> = {};
    for (const p of this.byKey.values()) out[p.key] = await p.healthCheck();
    return out;
  }
}
