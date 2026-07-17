import type { Clock } from '@flytrace/shared';
import { BaseProvider } from '../base-provider.ts';
import type {
  FlightStatusQuery,
  NormalizedFlightStatus,
  ProviderCapabilities,
  ProviderFactory,
} from '../types.ts';

export interface FixtureProviderOptions {
  key: string;
  airlineIata: string[];
  /** Build the status for a query (defaults to a plausible active flight). */
  build?: (q: FlightStatusQuery, clock: Clock, key: string) => NormalizedFlightStatus;
}

function defaultBuild(q: FlightStatusQuery, clock: Clock, key: string): NormalizedFlightStatus {
  const flightNumber = q.by === 'flightNumber' ? q.flightNumber : `${q.from}${q.to}`;
  return {
    flightNumber,
    airlineIata: flightNumber.slice(0, 2),
    origin: q.by === 'route' ? q.from : 'IST',
    destination: q.by === 'route' ? q.to : 'LHR',
    status: 'active',
    gate: 'A12',
    terminal: '1',
    source: key,
    fetchedAt: clock.nowIso(),
    confidence: 0.9,
  };
}

/**
 * A configurable, network-free provider for offline dev, demos, and the
 * pipeline smoke — the provider-side analogue of the tracker's fixture feed.
 * Real airline providers replace it once their sources are compliance-cleared.
 */
export class FixtureProvider extends BaseProvider {
  readonly key: string;
  readonly airlineIata: string[];
  readonly capabilities: ProviderCapabilities = {
    status: true,
    gate: true,
    baggage: false,
    schedule: true,
  };
  protected readonly cacheTtlMs = 60_000;
  private readonly build: NonNullable<FixtureProviderOptions['build']>;

  constructor(opts: FixtureProviderOptions) {
    super();
    this.key = opts.key;
    this.airlineIata = opts.airlineIata;
    this.build = opts.build ?? defaultBuild;
  }

  protected async fetchRaw(q: FlightStatusQuery): Promise<unknown> {
    return this.build(q, this.ctx.clock, this.key);
  }

  protected normalize(raw: unknown): NormalizedFlightStatus {
    return raw as NormalizedFlightStatus;
  }
}

export function fixtureProviderFactory(opts: FixtureProviderOptions): ProviderFactory {
  return { key: opts.key, airlineIata: opts.airlineIata, create: () => new FixtureProvider(opts) };
}
