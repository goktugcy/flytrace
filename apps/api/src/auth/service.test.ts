import { describe, expect, test } from 'bun:test';
import type { AuthRepo, AuthUser, SessionWithUser } from '@flytrace/db';
import { fixedClock, isAppError } from '@flytrace/shared';
import { AuthService, type Hasher } from './service.ts';

/** Fast, deterministic stand-ins for the KDF and the DB. */
const fakeHasher: Hasher = {
  hash: async (pw) => `h:${pw}`,
  verify: async (pw, h) => h === `h:${pw}`,
};

class InMemoryAuthRepo implements AuthRepo {
  private usersByEmail = new Map<string, AuthUser & { passwordHash: string | null }>();
  private sessions = new Map<string, SessionWithUser>();
  private seq = 0;

  async findUserByEmail(email: string) {
    return this.usersByEmail.get(email) ?? null;
  }
  async createUser(input: { email: string; name: string | null; passwordHash: string }) {
    this.seq += 1;
    const user: AuthUser = {
      id: `u${this.seq}`,
      email: input.email,
      name: input.name,
      role: 'user',
    };
    this.usersByEmail.set(input.email, { ...user, passwordHash: input.passwordHash });
    return user;
  }
  async createSession(input: { userId: string; token: string; expiresAt: Date }) {
    const user = [...this.usersByEmail.values()].find((u) => u.id === input.userId);
    if (!user) throw new Error('no user');
    this.sessions.set(input.token, {
      userId: input.userId,
      expiresAt: input.expiresAt.toISOString(),
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  }
  async findSession(token: string) {
    return this.sessions.get(token) ?? null;
  }
  async deleteSession(token: string) {
    this.sessions.delete(token);
  }
}

function make() {
  let n = 0;
  const genToken = () => {
    n += 1;
    return `tok${n}`;
  };
  const repo = new InMemoryAuthRepo();
  const service = new AuthService({
    repo,
    clock: fixedClock(1_700_000_000_000),
    hasher: fakeHasher,
    sessionTtlMs: 1000,
    genToken,
  });
  return { repo, service };
}

describe('AuthService', () => {
  test('sign-up creates a user and a session', async () => {
    const { service } = make();
    const r = await service.signUp({ email: 'A@Example.com ', password: 'hunter2!', name: 'Ada' });
    expect(r.user.email).toBe('a@example.com'); // normalized
    expect(r.token).toBe('tok1');
    const s = await service.session(r.token);
    expect(s?.user.id).toBe(r.user.id);
  });

  test('sign-up rejects a duplicate email', async () => {
    const { service } = make();
    await service.signUp({ email: 'a@example.com', password: 'hunter2!' });
    const err = await service
      .signUp({ email: 'a@example.com', password: 'other123' })
      .catch((e) => e);
    expect(isAppError(err) && err.code).toBe('CONFLICT');
  });

  test('sign-in verifies the password', async () => {
    const { service } = make();
    await service.signUp({ email: 'a@example.com', password: 'hunter2!' });
    const ok = await service.signIn({ email: 'a@example.com', password: 'hunter2!' });
    expect(ok.user.email).toBe('a@example.com');

    const bad = await service.signIn({ email: 'a@example.com', password: 'wrong' }).catch((e) => e);
    expect(isAppError(bad) && bad.code).toBe('UNAUTHENTICATED');

    const missing = await service
      .signIn({ email: 'nobody@example.com', password: 'x' })
      .catch((e) => e);
    expect(isAppError(missing) && missing.code).toBe('UNAUTHENTICATED');
  });

  test('session returns null without a token, and sign-out revokes', async () => {
    const { service } = make();
    expect(await service.session(undefined)).toBeNull();
    const r = await service.signUp({ email: 'a@example.com', password: 'hunter2!' });
    expect(await service.session(r.token)).not.toBeNull();
    await service.signOut(r.token);
    expect(await service.session(r.token)).toBeNull();
  });
});
