import { createNotifyRepo } from '@flytrace/db';
import { AppError, DB_EVENT_TYPES } from '@flytrace/shared';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.ts';
import { requireUser } from '../auth/routes.ts';
import type { AppContext } from '../context.ts';

const createWatchSchema = z.object({
  flightId: z.string().uuid(),
  match: z.record(z.unknown()).default({}),
  eventTypes: z.array(z.enum(DB_EVENT_TYPES)).min(1),
  channels: z.array(z.enum(['telegram', 'webpush', 'email'])).min(1),
});

const webPushSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});

/**
 * User notification endpoints (docs/11 §11.6, docs/10 §10.2): watchlist CRUD +
 * Web Push subscription + history. All owner-scoped behind requireUser; the
 * VAPID public key is public so the browser can build a subscription.
 */
export function createNotifyRoutes(ctx: AppContext): Hono<AppEnv> {
  const repo = createNotifyRepo(ctx.db);
  const app = new Hono<AppEnv>();
  const ok = (c: Context<AppEnv>, data: unknown, status = 200) =>
    c.json({ data, meta: { requestId: c.get('requestId') } }, status as 200);

  // Public: VAPID key for the browser to subscribe.
  app.get('/config/webpush', (c) => ok(c, { publicKey: ctx.config.WEB_PUSH_PUBLIC_KEY ?? null }));

  app.use('/watchlist', requireUser());
  app.use('/watchlist/*', requireUser());
  app.use('/notifications', requireUser());
  app.use('/channels/*', requireUser());

  app.get('/watchlist', async (c) => {
    const user = c.get('user');
    return ok(c, { items: await repo.listWatches(user?.id ?? '') });
  });

  app.post('/watchlist', async (c) => {
    const user = c.get('user');
    if (!user) throw new AppError('UNAUTHENTICATED', 'sign in required');
    const parsed = createWatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new AppError('VALIDATION_ERROR', 'invalid watch', { details: parsed.error.issues });
    const created = await repo.createWatch({
      userId: user.id,
      flightId: parsed.data.flightId,
      match: parsed.data.match,
      eventTypes: parsed.data.eventTypes,
      channels: parsed.data.channels,
    });
    return ok(c, { id: created.id }, 201);
  });

  app.delete('/watchlist/:id', async (c) => {
    const user = c.get('user');
    if (!user) throw new AppError('UNAUTHENTICATED', 'sign in required');
    const removed = await repo.deleteWatch(c.req.param('id'), user.id);
    if (!removed) throw new AppError('NOT_FOUND', 'watch not found');
    return ok(c, { ok: true });
  });

  app.post('/channels/webpush/subscribe', async (c) => {
    const user = c.get('user');
    if (!user) throw new AppError('UNAUTHENTICATED', 'sign in required');
    const parsed = webPushSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new AppError('VALIDATION_ERROR', 'invalid subscription', {
        details: parsed.error.issues,
      });
    await repo.upsertWebPush(user.id, parsed.data);
    return ok(c, { ok: true }, 201);
  });

  app.get('/notifications', async (c) => {
    const user = c.get('user');
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);
    return ok(c, { items: await repo.listForUser(user?.id ?? '', limit) });
  });

  return app;
}
