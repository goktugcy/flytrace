import { describe, expect, it } from 'bun:test';
import { AppError, fixedClock } from '@flytrace/shared';
import {
  RefreshTokenService,
  type TokenHasher,
  createInMemoryRefreshTokenRepo,
} from './refresh-tokens.ts';

// Deterministic fakes: identity-ish hash + counter-based token/family generator.
const fakeHasher: TokenHasher = { hash: (t) => `H:${t}` };

function makeService(ttlMs = 60_000) {
  const repo = createInMemoryRefreshTokenRepo();
  const clock = fixedClock(1_000);
  let n = 0;
  const random = () => `tok_${n++}`;
  const svc = new RefreshTokenService({ repo, clock, random, hasher: fakeHasher, ttlMs });
  return { repo, clock, svc };
}

describe('RefreshTokenService.issue', () => {
  it('issues an opaque token stored hashed with a future expiry', async () => {
    const { repo, svc } = makeService();
    const { token, expiresAt } = await svc.issue('user-1', 'dev-1');
    expect(token).toBe('tok_0');
    expect(expiresAt.getTime()).toBe(1_000 + 60_000);
    const rec = await repo.findByHash(fakeHasher.hash(token));
    expect(rec?.userId).toBe('user-1');
    expect(rec?.deviceId).toBe('dev-1');
    expect(rec?.revokedAt).toBeNull();
  });
});

describe('RefreshTokenService.rotate — happy path', () => {
  it('mints a successor in the same family and revokes the old token', async () => {
    const { repo, svc } = makeService();
    const first = await svc.issue('user-1', 'dev-1');
    const oldRec = await repo.findByHash(fakeHasher.hash(first.token));

    const second = await svc.rotate(first.token);
    expect(second.token).not.toBe(first.token);

    const oldAfter = await repo.findByHash(fakeHasher.hash(first.token));
    const newRec = await repo.findByHash(fakeHasher.hash(second.token));
    expect(oldAfter?.revokedAt).not.toBeNull();
    expect(oldAfter?.replacedBy).toBe(newRec?.id ?? '');
    expect(newRec?.revokedAt).toBeNull();
    // same rotation family carried across
    expect(newRec?.familyId).toBe(oldRec?.familyId ?? '');
  });

  it('supports repeated rotation', async () => {
    const { svc } = makeService();
    const a = await svc.issue('user-1', 'dev-1');
    const b = await svc.rotate(a.token);
    const c = await svc.rotate(b.token);
    expect(new Set([a.token, b.token, c.token]).size).toBe(3);
  });
});

describe('RefreshTokenService.rotate — reuse detection', () => {
  it('revokes the entire family when a rotated token is replayed', async () => {
    const { repo, svc } = makeService();
    const a = await svc.issue('user-1', 'dev-1');
    const b = await svc.rotate(a.token); // a now revoked
    const c = await svc.rotate(b.token); // b now revoked, c live

    // Replay the already-rotated token `a`.
    await expect(svc.rotate(a.token)).rejects.toBeInstanceOf(AppError);

    // Whole family burned — including the previously-live token c.
    const cRec = await repo.findByHash(fakeHasher.hash(c.token));
    expect(cRec?.revokedAt).not.toBeNull();
  });

  it('burns the family when a stale concurrent rotate tries to replace again', async () => {
    const { repo, svc } = makeService();
    const a = await svc.issue('user-1', 'dev-1');
    const first = await svc.rotate(a.token);
    const old = await repo.findByHash(fakeHasher.hash(a.token));
    expect(old?.revokedAt).not.toBeNull();

    await expect(repo.markReplaced(old!.id, 'late-successor', new Date())).resolves.toBe(false);
    await expect(svc.rotate(a.token)).rejects.toBeInstanceOf(AppError);
    expect((await repo.findByHash(fakeHasher.hash(first.token)))?.revokedAt).not.toBeNull();
  });

  it('rejects unknown and expired tokens', async () => {
    const { svc, clock } = makeService(1_000);
    await expect(svc.rotate('nope')).rejects.toBeInstanceOf(AppError);
    const t = await svc.issue('user-1', 'dev-1');
    clock.advance(2_000); // past ttl
    await expect(svc.rotate(t.token)).rejects.toBeInstanceOf(AppError);
  });
});

describe('RefreshTokenService revoke helpers', () => {
  it('revoke(token) revokes just that token', async () => {
    const { repo, svc } = makeService();
    const t = await svc.issue('user-1', 'dev-1');
    await svc.revoke(t.token);
    const rec = await repo.findByHash(fakeHasher.hash(t.token));
    expect(rec?.revokedAt).not.toBeNull();
  });

  it('revokeAllForUser revokes every live token for the user only', async () => {
    const { repo, svc } = makeService();
    const u1a = await svc.issue('user-1', 'dev-1');
    const u1b = await svc.issue('user-1', 'dev-2');
    const u2 = await svc.issue('user-2', 'dev-3');
    await svc.revokeAllForUser('user-1');
    expect((await repo.findByHash(fakeHasher.hash(u1a.token)))?.revokedAt).not.toBeNull();
    expect((await repo.findByHash(fakeHasher.hash(u1b.token)))?.revokedAt).not.toBeNull();
    expect((await repo.findByHash(fakeHasher.hash(u2.token)))?.revokedAt).toBeNull();
  });

  it('revokeAllForDevice revokes only that device', async () => {
    const { repo, svc } = makeService();
    const a = await svc.issue('user-1', 'dev-1');
    const b = await svc.issue('user-1', 'dev-2');
    await svc.revokeAllForDevice('dev-1');
    expect((await repo.findByHash(fakeHasher.hash(a.token)))?.revokedAt).not.toBeNull();
    expect((await repo.findByHash(fakeHasher.hash(b.token)))?.revokedAt).toBeNull();
  });
});
