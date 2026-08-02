import { createNotifyRepo } from '@flytrace/db';
import { telegramApi } from '@flytrace/notifications';
import { AppError, hashToken, randomToken } from '@flytrace/shared';
import { Hono } from 'hono';
import type { AppEnv } from '../app.ts';
import { requireUser } from '../auth/routes.ts';
import type { AppContext } from '../context.ts';

interface TelegramUpdate {
  message?: { chat?: { id?: number }; text?: string };
}

/**
 * Telegram linking + inbound webhook (docs/10 §10.6). The link endpoint (auth)
 * mints a one-time token → deep link; the webhook (public, secret-header
 * verified) resolves `/start <token>` to a chat_id and marks the channel
 * verified. `/stop` disables the chat's channels.
 */
export function createTelegramRoutes(ctx: AppContext): Hono<AppEnv> {
  const repo = createNotifyRepo(ctx.db);
  const token = ctx.config.TELEGRAM_BOT_TOKEN;
  const app = new Hono<AppEnv>();

  // Mint a deep link the user opens to connect their Telegram (auth required).
  app.post('/api/v1/channels/telegram/link', requireUser(), async (c) => {
    const user = c.get('user');
    if (!user) throw new AppError('UNAUTHENTICATED', 'sign in required');
    if (!ctx.config.TELEGRAM_BOT_USERNAME)
      throw new AppError('UPSTREAM_UNAVAILABLE', 'telegram not configured');
    // 16 bytes → 32 hex chars: comfortably inside Telegram's 64-char /start
    // payload limit while still far beyond guessing range. Only the digest is
    // persisted, and the link now expires.
    const linkToken = randomToken(16);
    const expiresAt = new Date(ctx.clock.now() + ctx.config.LINK_TOKEN_TTL_MINUTES * 60_000);
    await repo.createTelegramLink(user.id, hashToken(linkToken), expiresAt);
    return c.json(
      {
        data: {
          deepLink: `https://t.me/${ctx.config.TELEGRAM_BOT_USERNAME}?start=${linkToken}`,
          token: linkToken,
        },
        meta: { requestId: c.get('requestId') },
      },
      201,
    );
  });

  // Inbound webhook — Telegram calls this; verified by the secret-token header.
  app.post('/api/telegram/webhook', async (c) => {
    const secret = ctx.config.TELEGRAM_WEBHOOK_SECRET;
    if (secret && c.req.header('x-telegram-bot-api-secret-token') !== secret) {
      throw new AppError('FORBIDDEN', 'bad secret token');
    }
    const update = (await c.req.json().catch(() => ({}))) as TelegramUpdate;
    const chatId = update.message?.chat?.id;
    const text = update.message?.text?.trim() ?? '';
    if (chatId === undefined) return c.json({ ok: true });

    if (text.startsWith('/start ')) {
      const linkToken = text.slice('/start '.length).trim();
      const userId = await repo.consumeTelegramLink(hashToken(linkToken), chatId);
      await reply(
        token,
        chatId,
        userId ? '✅ Linked! You’ll get flight alerts here.' : '⚠️ This link is invalid or expired.',
      );
    } else if (text === '/stop') {
      await repo.disableTelegramByChat(chatId);
      await reply(token, chatId, 'Stopped. You won’t receive alerts here anymore.');
    } else if (text === '/start') {
      await reply(
        token,
        chatId,
        'Open FlyTrace → Settings → Connect Telegram to link your account.',
      );
    }
    return c.json({ ok: true });
  });

  return app;
}

async function reply(token: string | undefined, chatId: number, text: string): Promise<void> {
  if (!token) return;
  await telegramApi(token, 'sendMessage', { chat_id: chatId, text });
}
