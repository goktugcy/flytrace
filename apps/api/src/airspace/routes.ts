import {
  type Airspace,
  AirspaceService,
  groupByType,
  selectAirspaceProvider,
} from '@flytrace/airspace';
import { AppError } from '@flytrace/shared';
import { type Context, Hono } from 'hono';
import type { AppEnv } from '../app.ts';
import type { AppContext } from '../context.ts';

/**
 * Airspace lookup endpoint (docs/07). `GET /airspace/current?lat=&lon=[&alt=]`
 * returns every controlled-airspace volume containing the point, grouped by
 * kind plus a flat `matches` list. Backed by the same {@link AirspaceService}
 * the tracker uses; defaults to the in-repo mock dataset so it works locally
 * with no external services.
 *
 * The provider is selected from env (AIRSPACE_PROVIDER / *_DATASET_PATH); until
 * those keys are added to the API config schema (see manifest) they are read
 * from process.env here, defaulting to the mock fallback.
 */
function summarize(a: Airspace) {
  return {
    id: a.id,
    name: a.name,
    type: a.type,
    class: a.icaoClass,
    frequency: a.frequency ?? null,
    lowerFt: a.lowerFt,
    upperFt: a.upperFt,
  };
}

export function createAirspaceRoutes(ctx: AppContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Lazily built once, shared across requests. The mock dataset load is cheap
  // and memoized behind the service's TTL cache.
  let servicePromise: Promise<AirspaceService> | null = null;
  const getService = (): Promise<AirspaceService> => {
    if (!servicePromise) {
      servicePromise = (async () => {
        const provider = await selectAirspaceProvider({
          ...(process.env.AIRSPACE_PROVIDER ? { kind: process.env.AIRSPACE_PROVIDER } : {}),
          ...(process.env.OPENAIP_DATASET_PATH
            ? { openaipDatasetPath: process.env.OPENAIP_DATASET_PATH }
            : {}),
          ...(process.env.OPENFLIGHTMAPS_DATASET_PATH
            ? { openflightmapsDatasetPath: process.env.OPENFLIGHTMAPS_DATASET_PATH }
            : {}),
          ...(process.env.AIXM_DATASET_PATH
            ? { aixmDatasetPath: process.env.AIXM_DATASET_PATH }
            : {}),
          logger: ctx.logger,
        });
        const service = new AirspaceService(provider);
        await service.load();
        return service;
      })();
    }
    return servicePromise;
  };

  const ok = (c: Context<AppEnv>, data: unknown) =>
    c.json({ data, meta: { requestId: c.get('requestId') } });

  app.get('/airspace/current', async (c) => {
    const lat = Number(c.req.query('lat'));
    const lon = Number(c.req.query('lon'));
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new AppError('BAD_REQUEST', 'lat must be a number in [-90, 90]');
    }
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      throw new AppError('BAD_REQUEST', 'lon must be a number in [-180, 180]');
    }
    const altRaw = c.req.query('alt');
    const altFt = altRaw !== undefined && altRaw !== '' ? Number(altRaw) : null;
    if (altFt !== null && !Number.isFinite(altFt)) {
      throw new AppError('BAD_REQUEST', 'alt must be a number (feet)');
    }

    const service = await getService();
    const matches = service.currentAirspace(lat, lon, altFt);
    const grouped = groupByType(matches);

    // Primary controlling class/frequency: prefer the smallest (most specific)
    // volume — CTR over TMA over CTA over FIR.
    const priority: Record<Airspace['type'], number> = { CTR: 0, TMA: 1, CTA: 2, FIR: 3 };
    const primary = [...matches].sort((a, b) => priority[a.type] - priority[b.type])[0];

    return ok(c, {
      query: { lat, lon, altFt },
      fir: grouped.fir.map(summarize),
      tma: grouped.tma.map(summarize),
      cta: grouped.cta.map(summarize),
      ctr: grouped.ctr.map(summarize),
      class: primary?.icaoClass ?? null,
      frequency: primary?.frequency ?? null,
      name: primary?.name ?? null,
      matches: matches.map(summarize),
    });
  });

  return app;
}
