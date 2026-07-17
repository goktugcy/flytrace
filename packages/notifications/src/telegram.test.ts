import { describe, expect, test } from 'bun:test';
import { TelegramChannel } from './telegram.ts';

function fakeFetch(status: number) {
  const calls: { url: string; body: unknown }[] = [];
  const impl = (async (url: string | URL, init?: { body?: string }) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return { ok: status >= 200 && status < 300, status } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('TelegramChannel', () => {
  test('sends an HTML message with an Open-flight button', async () => {
    const { impl, calls } = fakeFetch(200);
    const ch = new TelegramChannel({
      token: 'BOT',
      webBaseUrl: 'https://app.test',
      fetchImpl: impl,
    });
    const res = await ch.send(
      { chatId: 42 },
      { title: 'Wheels up', body: 'TK1 departed', url: '/flights/id/x' },
    );

    expect(res.ok).toBe(true);
    expect(calls[0]?.url).toBe('https://api.telegram.org/botBOT/sendMessage');
    const body = calls[0]?.body as {
      chat_id: number;
      text: string;
      reply_markup: { inline_keyboard: { url: string }[][] };
    };
    expect(body.chat_id).toBe(42);
    expect(body.text).toContain('<b>Wheels up</b>');
    expect(body.reply_markup.inline_keyboard[0]?.[0]?.url).toBe('https://app.test/flights/id/x');
  });

  test('marks a 403 (bot blocked) as a dead endpoint', async () => {
    const { impl } = fakeFetch(403);
    const ch = new TelegramChannel({
      token: 'BOT',
      webBaseUrl: 'https://app.test',
      fetchImpl: impl,
    });
    const res = await ch.send({ chatId: 42 }, { title: 't', body: 'b', url: '/x' });
    expect(res).toEqual({ ok: false, gone: true, error: 'telegram 403' });
  });

  test('escapes HTML in title/body', async () => {
    const { impl, calls } = fakeFetch(200);
    const ch = new TelegramChannel({ token: 'B', webBaseUrl: 'https://a', fetchImpl: impl });
    await ch.send({ chatId: 1 }, { title: 'a<b>', body: 'x & y', url: '/x' });
    const body = calls[0]?.body as { text: string };
    expect(body.text).toContain('a&lt;b&gt;');
    expect(body.text).toContain('x &amp; y');
  });
});
