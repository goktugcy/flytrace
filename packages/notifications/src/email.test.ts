import { describe, expect, test } from 'bun:test';
import { EmailChannel, FakeEmailTransport } from './email.ts';

describe('EmailChannel', () => {
  test('sends HTML + text with deep link and unsubscribe footer', async () => {
    const transport = new FakeEmailTransport();
    const ch = new EmailChannel({
      from: 'FlyTrace <a@f.test>',
      transport,
      webBaseUrl: 'https://app.test',
    });
    const res = await ch.send(
      { email: 'user@example.com' },
      { title: 'Landed', body: 'TK1 arrived', url: '/flights/id/x' },
    );

    expect(res.ok).toBe(true);
    const sent = transport.sent[0];
    expect(sent?.to).toBe('user@example.com');
    expect(sent?.from).toBe('FlyTrace <a@f.test>');
    expect(sent?.subject).toBe('Landed');
    expect(sent?.html).toContain('https://app.test/flights/id/x');
    expect(sent?.html).toContain('Manage notifications');
    expect(sent?.text).toContain('TK1 arrived');
  });

  test('a 422 from the provider marks the address dead', async () => {
    const ch = new EmailChannel({
      from: 'a@f.test',
      transport: new FakeEmailTransport({ status: 422 }),
      webBaseUrl: 'https://app.test',
    });
    const res = await ch.send({ email: 'bad@example.com' }, { title: 't', body: 'b', url: '/x' });
    expect(res).toEqual({ ok: false, gone: true, error: 'email 422' });
  });
});
