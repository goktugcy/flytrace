import { AppError } from '@flytrace/shared';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.ts';
import { WeatherService } from './service.ts';

const coordinateSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  alt: z.coerce.number().min(-2_000).max(70_000).optional(),
});

const bboxSchema = z.string().transform((raw, ctx) => {
  const values = raw.split(',').map(Number);
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bbox must be "w,s,e,n"' });
    return z.NEVER;
  }
  const [west, south, east, north] = values as [number, number, number, number];
  if (
    west < -180 ||
    west > 180 ||
    east < -180 ||
    east > 180 ||
    south < -90 ||
    south > 90 ||
    north < -90 ||
    north > 90 ||
    south >= north
  ) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bbox coordinates are invalid' });
    return z.NEVER;
  }
  return [west, south, east, north] as const;
});

export function createWeatherRoutes(service = new WeatherService()): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const ok = (c: Context<AppEnv>, data: unknown) =>
    c.json({ data, meta: { requestId: c.get('requestId'), cached: false } });

  app.get('/weather/point', async (c) => {
    const parsed = coordinateSchema.safeParse({
      lat: c.req.query('lat'),
      lon: c.req.query('lon'),
      alt: c.req.query('alt'),
    });
    if (!parsed.success) {
      throw new AppError('BAD_REQUEST', 'invalid weather coordinates', {
        details: parsed.error.issues,
      });
    }
    return ok(c, {
      weather: await service.point(parsed.data.lat, parsed.data.lon, parsed.data.alt),
    });
  });

  app.get('/weather/viewport', async (c) => {
    const bbox = bboxSchema.safeParse(c.req.query('bbox'));
    const zoom = z.coerce
      .number()
      .min(0)
      .max(22)
      .safeParse(c.req.query('zoom') ?? 5);
    if (!bbox.success || !zoom.success) {
      throw new AppError('BAD_REQUEST', 'invalid weather viewport', {
        details: [
          ...(!bbox.success ? bbox.error.issues : []),
          ...(!zoom.success ? zoom.error.issues : []),
        ],
      });
    }
    return ok(c, await service.viewport(bbox.data, zoom.data));
  });

  // Dense wind + scalar grid for the Windy-style overlay (color field + particles).
  app.get('/weather/field', async (c) => {
    const bbox = bboxSchema.safeParse(c.req.query('bbox'));
    const cols = z.coerce
      .number()
      .int()
      .min(4)
      .max(24)
      .safeParse(c.req.query('cols') ?? 16);
    const rows = z.coerce
      .number()
      .int()
      .min(4)
      .max(18)
      .safeParse(c.req.query('rows') ?? 12);
    if (!bbox.success || !cols.success || !rows.success) {
      throw new AppError('BAD_REQUEST', 'invalid weather field request', {
        details: [
          ...(!bbox.success ? bbox.error.issues : []),
          ...(!cols.success ? cols.error.issues : []),
          ...(!rows.success ? rows.error.issues : []),
        ],
      });
    }
    return ok(c, await service.field(bbox.data, cols.data, rows.data));
  });

  return app;
}
