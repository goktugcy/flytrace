import { describe, expect, test } from 'bun:test';
import { createEmailProvider } from './index.ts';
import { MockEmailProvider } from './mock.ts';
import type { SmtpTransport } from './smtp.ts';

const msg = {
  to: 'x@example.com',
  from: 'FlyTrace <d@f.test>',
  subject: 'Hi',
  html: '<p>hi</p>',
  text: 'hi',
};

/** Minimal fetch stub returning a JSON body with a chosen status. */
function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('MockEmailProvider', () => {
  test('records sends and returns a deterministic id', async () => {
    const p = new MockEmailProvider({ now: () => 1000 });
    const r1 = await p.send(msg);
    const r2 = await p.send(msg);
    expect(p.sent).toHaveLength(2);
    expect(r1.id).toBe('mock-1000-1');
    expect(r2.id).toBe('mock-1000-2');
  });
});

describe('createEmailProvider', () => {
  test('defaults to mock when nothing configured', async () => {
    const p = await createEmailProvider();
    expect(p.name).toBe('mock');
  });

  test('downgrades resend to mock when API key missing', async () => {
    const warnings: string[] = [];
    const p = await createEmailProvider({
      provider: 'resend',
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(p.name).toBe('mock');
    expect(warnings.some((w) => w.includes('resend'))).toBe(true);
  });

  test('downgrades brevo to mock when key missing', async () => {
    const p = await createEmailProvider({ provider: 'brevo' });
    expect(p.name).toBe('mock');
  });

  test('downgrades smtp to mock when no transport injected', async () => {
    const p = await createEmailProvider({ provider: 'smtp' });
    expect(p.name).toBe('mock');
  });

  test('selects resend when API key present', async () => {
    const p = await createEmailProvider({
      provider: 'resend',
      apiKey: 'k',
      fetchImpl: fakeFetch(200, { id: 'r-1' }),
    });
    expect(p.name).toBe('resend');
    expect(await p.send(msg)).toEqual({ id: 'r-1' });
  });

  test('selects brevo, falling back to EMAIL_API_KEY, and maps messageId', async () => {
    const p = await createEmailProvider({
      provider: 'brevo',
      apiKey: 'shared-key',
      fetchImpl: fakeFetch(201, { messageId: 'b-9' }),
    });
    expect(p.name).toBe('brevo');
    expect(await p.send(msg)).toEqual({ id: 'b-9' });
  });

  test('selects smtp with an injected transport', async () => {
    const sent: unknown[] = [];
    const transport: SmtpTransport = {
      async sendMail(m) {
        sent.push(m);
        return { messageId: 's-1' };
      },
    };
    const p = await createEmailProvider({ provider: 'smtp', smtpTransport: transport });
    expect(p.name).toBe('smtp');
    expect(await p.send(msg)).toEqual({ id: 's-1' });
    expect(sent).toHaveLength(1);
  });

  test('resend throws on non-2xx so retry/queue can react', async () => {
    const p = await createEmailProvider({
      provider: 'resend',
      apiKey: 'k',
      fetchImpl: fakeFetch(500, {}),
    });
    await expect(p.send(msg)).rejects.toThrow('resend');
  });
});
