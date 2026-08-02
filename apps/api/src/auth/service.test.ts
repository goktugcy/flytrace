import { describe, expect, test } from 'bun:test';
import { fixedClock, hashToken, isAppError } from '@flytrace/shared';
import { AuthService, type Hasher } from './service.ts';
import { InMemoryAuthRepo } from './testing.ts';

/** Fast, deterministic stand-ins for the KDF and the DB. */
const fakeHasher: Hasher = {
  hash: async (pw) => `h:${pw}`,
  verify: async (pw, h) => h === `h:${pw}`,
};

function make() {
  let n = 0;
  const genToken = () => {
    n += 1;
    return `tok${n}`;
  };
  const clock = fixedClock(1_700_000_000_000);
  const repo = new InMemoryAuthRepo();
  repo.now = () => clock.now();
  const service = new AuthService({
    repo,
    clock,
    hasher: fakeHasher,
    sessionTtlMs: 1000,
    genToken,
  });
  return { repo, service, clock };
}

describe('AuthService', () => {
  test('sign-up creates a user but does NOT create a session', async () => {
    const { service, repo } = make();
    const user = await service.signUp({
      email: 'A@Example.com ',
      password: 'hunter2!',
      name: 'Ada',
    });
    expect(user.email).toBe('a@example.com'); // normalized
    // Session creation is the sign-in flow's job, not sign-up's — this is what
    // keeps "password accepted" from implying "authenticated".
    expect(repo.sessionCount).toBe(0);
  });

  test('sign-up rejects a duplicate email', async () => {
    const { service } = make();
    await service.signUp({ email: 'a@example.com', password: 'hunter2!' });
    const err = await service
      .signUp({ email: 'a@example.com', password: 'other123' })
      .catch((e) => e);
    expect(isAppError(err) && err.code).toBe('CONFLICT');
  });

  test('verifyCredentials accepts the right password and creates no session', async () => {
    const { service, repo } = make();
    await service.signUp({ email: 'a@example.com', password: 'hunter2!' });
    const ok = await service.verifyCredentials({ email: 'a@example.com', password: 'hunter2!' });
    expect(ok.user.email).toBe('a@example.com');
    expect(repo.sessionCount).toBe(0);
  });

  test('verifyCredentials rejects wrong password and unknown user identically', async () => {
    const { service } = make();
    await service.signUp({ email: 'a@example.com', password: 'hunter2!' });

    const bad = await service
      .verifyCredentials({ email: 'a@example.com', password: 'wrong' })
      .catch((e) => e);
    const missing = await service
      .verifyCredentials({ email: 'nobody@example.com', password: 'x' })
      .catch((e) => e);

    expect(isAppError(bad) && bad.code).toBe('UNAUTHENTICATED');
    expect(isAppError(missing) && missing.code).toBe('UNAUTHENTICATED');
    // Identical message: the endpoint must not reveal whether the account exists.
    expect((bad as Error).message).toBe((missing as Error).message);
  });

  test('startSession stores only the token HASH, never the raw token', async () => {
    const { service, repo } = make();
    const user = await service.signUp({ email: 'a@example.com', password: 'hunter2!' });
    const session = await service.startSession({ user, ip: null, userAgent: null });

    expect(session.token).toBe('tok1');
    expect(repo.storedTokenHashes).toEqual([hashToken('tok1')]);
    expect(repo.storedTokenHashes).not.toContain('tok1');
  });

  test('session() resolves a raw token by hashing it, and sign-out revokes', async () => {
    const { service } = make();
    expect(await service.session(undefined)).toBeNull();
    const user = await service.signUp({ email: 'a@example.com', password: 'hunter2!' });
    const session = await service.startSession({ user, ip: null, userAgent: null });

    expect(await service.session(session.token)).not.toBeNull();
    // A hash presented as if it were the token must not authenticate.
    expect(await service.session(hashToken(session.token))).toBeNull();

    await service.signOut(session.token);
    expect(await service.session(session.token)).toBeNull();
  });

  test('an expired session no longer resolves', async () => {
    const { service, clock } = make();
    const user = await service.signUp({ email: 'a@example.com', password: 'hunter2!' });
    const session = await service.startSession({ user, ip: null, userAgent: null });
    expect(await service.session(session.token)).not.toBeNull();
    clock.advance(1001);
    expect(await service.session(session.token)).toBeNull();
  });

  test('signOutAll drops every session for the user', async () => {
    const { service, repo } = make();
    const user = await service.signUp({ email: 'a@example.com', password: 'hunter2!' });
    await service.startSession({ user, ip: null, userAgent: null });
    await service.startSession({ user, ip: null, userAgent: null });
    expect(repo.sessionCount).toBe(2);

    expect(await service.signOutAll(user.id)).toBe(2);
    expect(repo.sessionCount).toBe(0);
  });

  test('signOutDevice drops only that device’s sessions', async () => {
    const { service, repo } = make();
    const user = await service.signUp({ email: 'a@example.com', password: 'hunter2!' });
    await service.startSession({ user, ip: null, userAgent: null, deviceId: 'dev-1' });
    await service.startSession({ user, ip: null, userAgent: null, deviceId: 'dev-2' });

    expect(await service.signOutDevice('dev-1')).toBe(1);
    expect(repo.sessionCount).toBe(1);
  });
});
