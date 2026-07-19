/**
 * Airspace provider abstraction. Business code (the AirspaceService, the API
 * route) depends only on {@link AirspaceProvider}; the concrete adapter is
 * chosen from config at composition time via the shared `selectAdapter`
 * convention, with the in-repo `mock` as the always-present fallback so the
 * tracker boots with zero external datasets.
 *
 * Real adapters (openAIP / open-flightmaps / AIXM) parse their native format
 * when a dataset path/URL is configured; otherwise they load nothing (no-op)
 * and behave like an empty dataset — never throwing, always degrading.
 */
import { type Logger, selectAdapter } from '@flytrace/shared';
import { SpatialIndex } from '../spatial-index.ts';
import type { Airspace } from '../types.ts';

export interface AirspaceProvider {
  /** Load (and parse) the dataset. Idempotent; safe to call again to refresh. */
  load(): Promise<void>;
  /** The loaded, normalized dataset. Empty until load() completes. */
  allAirspaces(): Airspace[];
  /** All airspaces whose 2-D geometry contains the given point. */
  findContainingAirspace(lat: number, lon: number): Airspace[];
}

/** Provider names understood by {@link selectAirspaceProvider}. */
export type AirspaceProviderKind = 'mock' | 'openaip' | 'openflightmaps' | 'aixm';

export interface AirspaceProviderOptions {
  /** Selected provider (config `AIRSPACE_PROVIDER`). Unknown ⇒ mock fallback. */
  kind?: string | undefined;
  /** openAIP dataset path or URL (config `OPENAIP_DATASET_PATH`). */
  openaipDatasetPath?: string | undefined;
  /** openAIP Core API key (config `OPENAIP_API_KEY`). */
  openaipApiKey?: string | undefined;
  /** openAIP Core API base URL (config `OPENAIP_BASE_URL`). */
  openaipBaseUrl?: string | undefined;
  /** ISO alpha-2 country filter for openAIP API mode (config `OPENAIP_COUNTRY`). */
  openaipCountry?: string | undefined;
  /** Bounding box filter for openAIP API mode (config `OPENAIP_BBOX`). */
  openaipBbox?: string | undefined;
  /** Page size for openAIP API mode (config `OPENAIP_PAGE_LIMIT`). */
  openaipPageLimit?: number | undefined;
  /** open-flightmaps dataset path or URL (config `OPENFLIGHTMAPS_DATASET_PATH`). */
  openflightmapsDatasetPath?: string | undefined;
  /** AIXM dataset path or URL (config `AIXM_DATASET_PATH`). */
  aixmDatasetPath?: string | undefined;
  logger?: Logger | undefined;
  /** Spatial-index grid cell size in degrees (advanced tuning). */
  cellDeg?: number | undefined;
}

/**
 * A base provider that owns the spatial index. Subclasses supply `fetch()`,
 * which returns the parsed airspaces; the base wires indexing + lookup so every
 * provider shares one lookup implementation.
 */
export abstract class BaseAirspaceProvider implements AirspaceProvider {
  protected index: SpatialIndex;
  private readonly cellDeg: number | undefined;

  constructor(cellDeg?: number) {
    this.cellDeg = cellDeg;
    this.index = new SpatialIndex(cellDeg ? { cellDeg } : {});
  }

  /** Parse and return the dataset's airspaces. No-op adapters return []. */
  protected abstract fetch(): Promise<Airspace[]>;

  async load(): Promise<void> {
    const airspaces = await this.fetch();
    this.index = SpatialIndex.build(airspaces, this.cellDeg ? { cellDeg: this.cellDeg } : {});
  }

  allAirspaces(): Airspace[] {
    return this.index.list();
  }

  findContainingAirspace(lat: number, lon: number): Airspace[] {
    return this.index.findContaining(lat, lon);
  }
}

/**
 * Resolve the configured airspace provider, falling back to `mock`. Adapters
 * are lazily imported so parsing dependencies aren't pulled in for mock/local.
 */
export async function selectAirspaceProvider(
  opts: AirspaceProviderOptions = {},
): Promise<AirspaceProvider> {
  const logger = opts.logger;
  return selectAdapter<AirspaceProvider>({
    label: 'airspace',
    kind: opts.kind,
    fallback: 'mock',
    ...(logger
      ? {
          logger: {
            warn: (m: string, meta?: unknown) => logger.warn(m, meta as Record<string, unknown>),
          },
        }
      : {}),
    adapters: {
      mock: async () => {
        const { MockAirspaceProvider } = await import('./mock.ts');
        return new MockAirspaceProvider(opts.cellDeg);
      },
      openaip: async () => {
        const { OpenAipAirspaceProvider } = await import('./openaip.ts');
        return new OpenAipAirspaceProvider(opts.openaipDatasetPath, opts.cellDeg, logger, {
          apiKey: opts.openaipApiKey,
          baseUrl: opts.openaipBaseUrl,
          country: opts.openaipCountry,
          bbox: opts.openaipBbox,
          pageLimit: opts.openaipPageLimit,
        });
      },
      openflightmaps: async () => {
        const { OpenFlightmapsAirspaceProvider } = await import('./openflightmaps.ts');
        return new OpenFlightmapsAirspaceProvider(
          opts.openflightmapsDatasetPath,
          opts.cellDeg,
          logger,
        );
      },
      aixm: async () => {
        const { AixmAirspaceProvider } = await import('./aixm.ts');
        return new AixmAirspaceProvider(opts.aixmDatasetPath, opts.cellDeg, logger);
      },
    },
  });
}
