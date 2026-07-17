import type {
  ChannelAddress,
  DeliveryResult,
  NotificationChannel,
  RenderedMessage,
} from './types.ts';

interface TelegramAddress {
  chatId: number | string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Low-level Bot API call, shared by the channel + the api webhook reply. */
export async function telegramApi(
  token: string,
  method: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number }> {
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status };
}

/** Telegram Bot channel (docs/10 §10.6): HTML text + an "Open flight" button. */
export class TelegramChannel implements NotificationChannel {
  readonly key = 'telegram' as const;

  constructor(
    private readonly opts: { token: string; webBaseUrl: string; fetchImpl?: typeof fetch },
  ) {}

  async send(address: ChannelAddress, message: RenderedMessage): Promise<DeliveryResult> {
    const chatId = (address as unknown as TelegramAddress).chatId;
    try {
      const { ok, status } = await telegramApi(
        this.opts.token,
        'sendMessage',
        {
          chat_id: chatId,
          text: `<b>${escapeHtml(message.title)}</b>\n${escapeHtml(message.body)}`,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Open flight', url: `${this.opts.webBaseUrl}${message.url}` }],
            ],
          },
        },
        this.opts.fetchImpl,
      );
      if (ok) return { ok: true };
      // 403 = user blocked the bot → dead endpoint.
      return { ok: false, gone: status === 403, error: `telegram ${status}` };
    } catch (err) {
      return { ok: false, gone: false, error: String(err) };
    }
  }
}
