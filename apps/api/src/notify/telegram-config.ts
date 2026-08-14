/**
 * One decision for "is Telegram usable, and is its webhook safe to expose?".
 *
 * `POST /api/telegram/webhook` is a PUBLIC endpoint — nginx proxies `/api/` to
 * the API, and Telegram must be able to reach it. The only thing separating a
 * genuine Telegram update from a forged one is the
 * `X-Telegram-Bot-Api-Secret-Token` header, which Telegram attaches because we
 * registered it with `setWebhook`.
 *
 * Without that secret the endpoint accepts anything anyone posts, and the
 * handler acts on it:
 *
 *   - a forged `/stop` with a guessed chat_id disables that user's alerts;
 *     `disableTelegramByChat` matches on chat_id alone, with no proof the caller
 *     owns it
 *   - any forged update makes the bot reply, so an attacker can drive your bot
 *     into messaging arbitrary people — which is how a bot gets banned
 *
 * So the secret is REQUIRED wherever Telegram is enabled outside local
 * development, and the webhook fails closed when it is missing.
 */
export interface TelegramConfigInput {
  APP_ENV: string;
  TELEGRAM_BOT_TOKEN?: string | undefined;
  TELEGRAM_BOT_USERNAME?: string | undefined;
  TELEGRAM_WEBHOOK_SECRET?: string | undefined;
}

export interface TelegramDecision {
  /** False when no bot token is configured — the routes then refuse politely. */
  enabled: boolean;
  botToken: string | null;
  botUsername: string | null;
  /** Null only in local development; the webhook rejects everything when null. */
  webhookSecret: string | null;
}

/** Telegram's own minimum for `setWebhook`'s secret_token is 1 char; ours is stricter. */
const MIN_SECRET_LENGTH = 16;

export function resolveTelegram(cfg: TelegramConfigInput): TelegramDecision {
  const botToken = cfg.TELEGRAM_BOT_TOKEN?.trim() || null;
  const botUsername = cfg.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, '') || null;
  const secret = cfg.TELEGRAM_WEBHOOK_SECRET?.trim() || null;
  const isDeployed = cfg.APP_ENV === 'production' || cfg.APP_ENV === 'staging';

  if (!botToken) {
    // Telegram simply not in use. Nothing to protect, nothing to require.
    return { enabled: false, botToken: null, botUsername, webhookSecret: secret };
  }

  if (isDeployed) {
    if (!secret) {
      throw new Error(
        'TELEGRAM_WEBHOOK_SECRET is required when TELEGRAM_BOT_TOKEN is set outside local ' +
          'development: /api/telegram/webhook is public, and without the secret anyone can forge ' +
          'updates — a /stop with a guessed chat_id disables that user’s alerts, and any forged ' +
          'update makes your bot message arbitrary people. Generate one (openssl rand -hex 32) and ' +
          'pass the SAME value to setWebhook as secret_token.',
      );
    }
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `TELEGRAM_WEBHOOK_SECRET must be at least ${MIN_SECRET_LENGTH} characters (got ${secret.length})`,
      );
    }
    if (!botUsername) {
      // Without it the deep link is "https://t.me/undefined?start=…".
      throw new Error(
        'TELEGRAM_BOT_USERNAME is required when TELEGRAM_BOT_TOKEN is set outside local development: ' +
          'the account-linking deep link is built from it.',
      );
    }
  }

  return { enabled: true, botToken, botUsername, webhookSecret: secret };
}
