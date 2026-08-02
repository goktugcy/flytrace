import { describe, expect, it } from 'bun:test';
import { AppError, fixedClock, hashToken } from '@flytrace/shared';
import {
  RefreshTokenReuseError,
  RefreshTokenService,
  type TokenHasher,
  createInMemoryRefreshTokenRepo,
} from './refresh-tokens.ts';

// Deterministic fakes: identity-ish hash + counter-based token/family generator.
const fakeHasher: TokenHasher = { hash: (t) => `H:${t}` };

function makeService(ttlMs = 60_000, reuseGraceMs = 0) {
  const repo = createInMemoryRefreshTokenRepo();
  const clock = fixedClock(1_000);
  let n = 0;
  const random = () => `tok_${n++}`;
  const svc = new RefreshTokenService({
    repo,
    clock,
    random,
    hasher: fakeHasher,
    ttlMs,
    reuseGraceMs,
  });
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

  it('surfaces reuse as a typed error carrying the blast radius', async () => {
    const { svc } = makeService();
    const a = await svc.issue('user-1', 'dev-1');
    await svc.rotate(a.token);

    const err = await svc.rotate(a.token).catch((e) => e);
    expect(err).toBeInstanceOf(RefreshTokenReuseError);
    expect((err as RefreshTokenReuseError).userId).toBe('user-1');
    expect((err as RefreshTokenReuseError).deviceId).toBe('dev-1');
    expect((err as RefreshTokenReuseError).familyId).toBeTruthy();
    // Client-facing message must not confirm the token was ever valid.
    expect((err as Error).message).toBe('invalid refresh token');
  });

  it('two concurrent rotations of the same token: one wins, one is reuse', async () => {
    const { repo, svc } = makeService();
    const a = await svc.issue('user-1', 'dev-1');

    const [first, second] = await Promise.allSettled([svc.rotate(a.token), svc.rotate(a.token)]);
    const fulfilled = [first, second].filter((r) => r.status === 'fulfilled');
    const rejected = [first, second].filter((r) => r.status === 'rejected');

    // Exactly one successor exists — the check-then-act is atomic.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(AppError);
    expect((await repo.findByHash(fakeHasher.hash(a.token)))?.revokedAt).not.toBeNull();
  });

  it('a replay inside the grace window is rejected WITHOUT burning the family', async () => {
    const { repo, svc, clock } = makeService(60_000, 10_000);
    const a = await svc.issue('user-1', 'dev-1');
    const b = await svc.rotate(a.token);

    clock.advance(5_000); // still inside the grace window
    const err = await svc.rotate(a.token).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).not.toBeInstanceOf(RefreshTokenReuseError);

    // The successor the client actually holds is still usable.
    expect((await repo.findByHash(fakeHasher.hash(b.token)))?.revokedAt).toBeNull();
    await expect(svc.rotate(b.token)).resolves.toBeDefined();
  });

  it('a replay past the grace window burns the family', async () => {
    const { repo, svc, clock } = makeService(60_000, 10_000);
    const a = await svc.issue('user-1', 'dev-1');
    const b = await svc.rotate(a.token);

    clock.advance(10_001);
    await expect(svc.rotate(a.token)).rejects.toBeInstanceOf(RefreshTokenReuseError);
    expect((await repo.findByHash(fakeHasher.hash(b.token)))?.revokedAt).not.toBeNull();
  });

  it('rejects unknown and expired tokens with an indistinguishable error', async () => {
    const { svc, clock } = makeService(1_000);
    const unknown = await svc.rotate('nope').catch((e) => e);
    expect(unknown).toBeInstanceOf(AppError);

    const t = await svc.issue('user-1', 'dev-1');
    clock.advance(2_000); // past ttl
    const expired = await svc.rotate(t.token).catch((e) => e);
    expect(expired).toBeInstanceOf(AppError);
    expect((unknown as Error).message).toBe((expired as Error).message);
  });
});

describe('RefreshTokenService — at-rest storage', () => {
  it('never persists the raw token, only its digest', async () => {
    const repo = createInMemoryRefreshTokenRepo();
    const svc = new RefreshTokenService({
      repo,
      clock: fixedClock(1_000),
      random: (() => {
        let n = 0;
        return () => `raw-token-${n++}`;
      })(),
      hasher: { hash: hashToken },
      ttlMs: 60_000,
    });

    const { token } = await svc.issue('user-1', 'dev-1');
    const stored = await repo.findByHash(hashToken(token));
    expect(stored).not.toBeNull();
    expect(stored?.tokenHash).toBe(hashToken(token));
    expect(stored?.tokenHash).not.toBe(token);
    // Presenting the digest instead of the token must not authenticate.
    await expect(svc.rotate(hashToken(token))).rejects.toBeInstanceOf(AppError);
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
