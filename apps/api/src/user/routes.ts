import { createNotifyRepo, createUserRepo } from '@flytrace/db';
import { AppError } from '@flytrace/shared';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.ts';
import { requireUser } from '../auth/routes.ts';
import type { AppContext } from '../context.ts';

const hhmm = z.string().regex(/^\d{2}:\d{2}$/);
const favoriteSchema = z.object({
  kind: z.enum(['route', 'aircraft', 'airport']),
  ref: z.record(z.unknown()),
});
const settingsSchema = z.object({
  theme: z.string().optional(),
  locale: z.string().optional(),
  distanceUnit: z.enum(['km', 'mi', 'nm']).optional(),
  timeFormat: z.enum(['12h', '24h']).optional(),
  quietHours: z.object({ tz: z.string(), start: hhmm, end: hhmm }).nullable().optional(),
  defaultChannels: z.array(z.enum(['telegram', 'webpush', 'email'])).optional(),
});

/**
 * User personalization endpoints (docs/11 §11.6): favorites, settings (incl.
 * quiet hours), connected channels, and the aggregated dashboard. All owner-
 * scoped behind requireUser.
 */
export function createUserRoutes(ctx: AppContext): Hono<AppEnv> {
  const users = createUserRepo(ctx.db);
  const notify = createNotifyRepo(ctx.db);
  const app = new Hono<AppEnv>();
  const uid = (c: Context<AppEnv>): string => {
    const u = c.get('user');
    if (!u) throw new AppError('UNAUTHENTICATED', 'sign in required');
    return u.id;
  };
  const ok = (c: Context<AppEnv>, data: unknown, status = 200) =>
    c.json({ data, meta: { requestId: c.get('requestId') } }, status as 200);

  app.use('/favorites', requireUser());
  app.use('/favorites/*', requireUser());
  app.use('/settings', requireUser());
  app.use('/channels', requireUser());
  app.use('/dashboard', requireUser());

  app.get('/favorites', async (c) => ok(c, { items: await users.listFavorites(uid(c)) }));
  app.post('/favorites', async (c) => {
    const parsed = favoriteSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new AppError('VALIDATION_ERROR', 'invalid favorite', { details: parsed.error.issues });
    return ok(c, await users.createFavorite(uid(c), parsed.data.kind, parsed.data.ref), 201);
  });
  app.delete('/favorites/:id', async (c) => {
    if (!(await users.deleteFavorite(c.req.param('id'), uid(c))))
      throw new AppError('NOT_FOUND', 'favorite not found');
    return ok(c, { ok: true });
  });

  app.get('/settings', async (c) => ok(c, { settings: (await users.getSettings(uid(c))) ?? {} }));
  app.patch('/settings', async (c) => {
    const parsed = settingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new AppError('VALIDATION_ERROR', 'invalid settings', { details: parsed.error.issues });
    await users.upsertSettings(uid(c), parsed.data);
    return ok(c, { ok: true });
  });

  app.get('/channels', async (c) => ok(c, { items: await users.listChannels(uid(c)) }));

  app.get('/dashboard', async (c) => {
    const id = uid(c);
    const [watchlist, notifications, favorites, channels] = await Promise.all([
      notify.listWatches(id),
      notify.listForUser(id, 20),
      users.listFavorites(id),
      users.listChannels(id),
    ]);
    return ok(c, { watchlist, notifications, favorites, channels });
  });

  return app;
}
