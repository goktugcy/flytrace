import { describe, expect, test } from 'bun:test';
import { DigestService } from './digest-service.ts';
import { MockEmailProvider } from './email-provider/mock.ts';
import type { DigestModel } from './template.ts';

function modelFor(userId: string, items: DigestModel['items']): DigestModel {
  return {
    user: { id: userId, email: `${userId}@example.com` },
    periodLabel: 'This week',
    items,
  };
}

describe('DigestService', () => {
  test('sends when the model has items', async () => {
    const emailProvider = new MockEmailProvider();
    const svc = new DigestService({
      emailProvider,
      from: 'FlyTrace <d@f.test>',
      buildDigestFor: (id) => modelFor(id, [{ title: 't', detail: 'd', url: '/x' }]),
    });

    const outcome = await svc.sendDigest('u1');

    expect(outcome).toBe('sent');
    expect(emailProvider.sent).toHaveLength(1);
    expect(emailProvider.sent[0]!.to).toBe('u1@example.com');
    expect(emailProvider.sent[0]!.from).toBe('FlyTrace <d@f.test>');
    expect(emailProvider.sent[0]!.subject).toContain('This week');
  });

  test('skips when the model is null', async () => {
    const emailProvider = new MockEmailProvider();
    const svc = new DigestService({
      emailProvider,
      from: 'd@f.test',
      buildDigestFor: () => null,
    });

    expect(await svc.sendDigest('u1')).toBe('skipped');
    expect(emailProvider.sent).toHaveLength(0);
  });

  test('skips when there are no items', async () => {
    const emailProvider = new MockEmailProvider();
    const svc = new DigestService({
      emailProvider,
      from: 'd@f.test',
      buildDigestFor: (id) => modelFor(id, []),
    });

    expect(await svc.sendDigest('u1')).toBe('skipped');
    expect(emailProvider.sent).toHaveLength(0);
  });

  test('propagates provider send failures to the caller', async () => {
    const failing = {
      name: 'boom',
      send: async () => {
        throw new Error('smtp down');
      },
    };
    const svc = new DigestService({
      emailProvider: failing,
      from: 'd@f.test',
      buildDigestFor: (id) => modelFor(id, [{ title: 't', detail: 'd', url: '/x' }]),
    });

    await expect(svc.sendDigest('u1')).rejects.toThrow('smtp down');
  });
});
