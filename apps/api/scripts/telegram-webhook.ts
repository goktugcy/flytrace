/**
 * Register / inspect / remove the Telegram webhook.
 *
 *   bun run telegram:webhook status
 *   bun run telegram:webhook set   https://api.example.com
 *   bun run telegram:webhook clear
 *
 * `set` is the step that binds `TELEGRAM_WEBHOOK_SECRET` to the bot: Telegram
 * stores it and returns it in the `X-Telegram-Bot-Api-Secret-Token` header of
 * every update. If the value registered here and the value in the API's
 * environment ever diverge, every update is rejected — so this script reads the
 * secret from the same env the API does instead of taking it as an argument.
 *
 * Telegram will only deliver to HTTPS with a publicly-valid certificate. A
 * self-signed cert or a plain-HTTP URL is rejected by `setWebhook`, not by us.
 */
import { loadRootEnv } from '@flytrace/shared';

interface TelegramResponse {
  ok: boolean;
  result?: unknown;
  description?: string;
}

async function call(
  token: string,
  method: string,
  body: Record<string, unknown> = {},
): Promise<TelegramResponse> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as TelegramResponse;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  loadRootEnv();
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!token) fail('TELEGRAM_BOT_TOKEN is not set');

  const [command, baseUrl] = process.argv.slice(2);

  if (command === 'status') {
    const info = await call(token, 'getWebhookInfo');
    const me = await call(token, 'getMe');
    console.log('bot       :', JSON.stringify(me.result));
    console.log('webhook   :', JSON.stringify(info.result, null, 2));
    return;
  }

  if (command === 'clear') {
    // drop_pending_updates avoids replaying a backlog against a new deployment.
    const res = await call(token, 'deleteWebhook', { drop_pending_updates: true });
    console.log(res.ok ? 'webhook removed' : `failed: ${res.description}`);
    return;
  }

  if (command === 'set') {
    if (!baseUrl) fail('usage: telegram:webhook set https://api.example.com');
    if (!baseUrl.startsWith('https://')) {
      fail('Telegram only delivers to https:// URLs with a publicly-valid certificate');
    }
    if (!secret) {
      fail(
        'TELEGRAM_WEBHOOK_SECRET is not set. Without it the webhook accepts forged updates; ' +
          'generate one with `openssl rand -hex 32`, put it in the API environment, then re-run.',
      );
    }
    const url = `${baseUrl.replace(/\/$/, '')}/api/telegram/webhook`;
    const res = await call(token, 'setWebhook', {
      url,
      secret_token: secret,
      // We only act on messages; asking for less keeps forged-update surface
      // and delivery volume down.
      allowed_updates: ['message'],
      drop_pending_updates: true,
    });
    if (!res.ok) fail(`setWebhook failed: ${res.description}`);
    console.log(`webhook set to ${url}`);
    console.log('secret registered — the API must run with the SAME TELEGRAM_WEBHOOK_SECRET');
    return;
  }

  console.log('usage: telegram:webhook <status|set <https://host>|clear>');
  process.exit(command ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
