import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hashToken, loadRootEnv, randomToken } from '@flytrace/shared';
import { sql } from 'drizzle-orm';
import { type Database, createDb } from '../index.ts';
import { createAuthRepo } from './auth.ts';
import { createNotifyRepo } from './notify.ts';

/**
 * Integration coverage for the "no raw bearer token at rest" rule.
 *
 * These assertions are the ones that would catch a regression the unit tests
 * cannot: they read the actual columns back out of Postgres and prove the
 * plaintext is not there, and that the plaintext columns no longer exist.
 */
loadRootEnv();

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

let db: Database;
let closeDb: (() => Promise<void>) | undefined;

beforeAll(() => {
  if (!databaseUrl) return;
  const created = createDb({ url: databaseUrl, max: 1 });
  db = created.db;
  closeDb = created.close;
});

afterAll(async () => {
  await closeDb?.();
});

describeDb('auth repository (postgres integration)', () => {
  test('the plaintext token columns no longer exist', async () => {
    const rows = (await db.execute(sql`
      select table_name as "table", column_name as "column"
      from information_schema.columns
      where (table_name = 'sessions' and column_name = 'token')
         or (table_name = 'notification_channels' and column_name = 'link_token')
    `)) as unknown as Array<{ table: string; column: string }>;
    expect(rows).toEqual([]);
  });

  test('sessions are stored hashed and resolve by hash only', async () => {
    const repo = createAuthRepo(db);
    const email = `auth-${crypto.randomUUID()}@example.test`;
    const user = await repo.createUser({ email, name: null, passwordHash: 'argon2-placeholder' });
    const rawToken = randomToken();

    try {
      await repo.createSession({
        userId: user.id,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + 60_000),
        ip: '203.0.113.0/24',
        userAgent: 'UA/1',
        deviceId: null,
      });

      // Nothing in the row equals the token the client holds.
      const stored = (await db.execute(sql`
        select token_hash as "tokenHash" from sessions where user_id = ${user.id}::uuid
      `)) as unknown as Array<{ tokenHash: string }>;
      expect(stored).toHaveLength(1);
      expect(stored[0]?.tokenHash).toBe(hashToken(rawToken));
      expect(stored[0]?.tokenHash).not.toBe(rawToken);

      // Lookup succeeds by hash, and only by hash.
      expect((await repo.findSession(hashToken(rawToken)))?.userId).toBe(user.id);
      expect(await repo.findSession(rawToken)).toBeNull();

      await repo.deleteSession(hashToken(rawToken));
      expect(await repo.findSession(hashToken(rawToken))).toBeNull();
    } finally {
      await db.execute(sql`delete from users where id = ${user.id}::uuid`);
    }
  });

  test('an expired session does not resolve', async () => {
    const repo = createAuthRepo(db);
    const email = `expired-${crypto.randomUUID()}@example.test`;
    const user = await repo.createUser({ email, name: null, passwordHash: 'x' });
    const raw = randomToken();

    try {
      await repo.createSession({
        userId: user.id,
        tokenHash: hashToken(raw),
        expiresAt: new Date(Date.now() - 1_000),
        ip: null,
        userAgent: null,
      });
      expect(await repo.findSession(hashToken(raw))).toBeNull();
      expect(await repo.deleteExpiredSessions()).toBeGreaterThan(0);
    } finally {
      await db.execute(sql`delete from users where id = ${user.id}::uuid`);
    }
  });

  test('sign-out-all and per-device revocation clear the right rows', async () => {
    const repo = createAuthRepo(db);
    const email = `revoke-${crypto.randomUUID()}@example.test`;
    const user = await repo.createUser({ email, name: null, passwordHash: 'x' });
    const expiresAt = new Date(Date.now() + 60_000);
    const [a, b] = [randomToken(), randomToken()];

    try {
      const [deviceRow] = (await db.execute(sql`
        insert into user_devices (user_id, fingerprint, ua)
        values (${user.id}::uuid, ${`fp-${crypto.randomUUID()}`}, 'UA/1')
        returning id
      `)) as unknown as Array<{ id: string }>;
      const deviceId = deviceRow?.id as string;

      await repo.createSession({
        userId: user.id,
        tokenHash: hashToken(a),
        expiresAt,
        ip: null,
        userAgent: null,
        deviceId,
      });
      await repo.createSession({
        userId: user.id,
        tokenHash: hashToken(b),
        expiresAt,
        ip: null,
        userAgent: null,
        deviceId: null,
      });

      expect(await repo.listSessionsForUser(user.id)).toHaveLength(2);
      expect(await repo.deleteSessionsForDevice(deviceId)).toBe(1);
      expect(await repo.listSessionsForUser(user.id)).toHaveLength(1);
      expect(await repo.deleteSessionsForUser(user.id)).toBe(1);
      expect(await repo.listSessionsForUser(user.id)).toHaveLength(0);
    } finally {
      await db.execute(sql`delete from users where id = ${user.id}::uuid`);
    }
  });

  test('email verification links are stored hashed and expire', async () => {
    const authRepo = createAuthRepo(db);
    const notify = createNotifyRepo(db);
    const email = `verify-${crypto.randomUUID()}@example.test`;
    const user = await authRepo.createUser({ email, name: null, passwordHash: 'x' });
    const raw = randomToken();

    try {
      await notify.createEmailChannel(
        user.id,
        email,
        hashToken(raw),
        new Date(Date.now() + 60_000),
      );

      const stored = (await db.execute(sql`
        select link_token_hash as "hash" from notification_channels where user_id = ${user.id}::uuid
      `)) as unknown as Array<{ hash: string }>;
      expect(stored[0]?.hash).toBe(hashToken(raw));
      expect(stored[0]?.hash).not.toBe(raw);

      // The raw token cannot be used as a lookup key.
      expect(await notify.verifyEmailToken(raw)).toBeNull();
      // The digest can — exactly once.
      expect(await notify.verifyEmailToken(hashToken(raw))).toBe(user.id);
      expect(await notify.verifyEmailToken(hashToken(raw))).toBeNull();
    } finally {
      await db.execute(sql`delete from users where id = ${user.id}::uuid`);
    }
  });

  test('an expired verification link is refused', async () => {
    const authRepo = createAuthRepo(db);
    const notify = createNotifyRepo(db);
    const email = `stale-${crypto.randomUUID()}@example.test`;
    const user = await authRepo.createUser({ email, name: null, passwordHash: 'x' });
    const raw = randomToken();

    try {
      await notify.createEmailChannel(user.id, email, hashToken(raw), new Date(Date.now() - 1_000));
      expect(await notify.verifyEmailToken(hashToken(raw))).toBeNull();
      expect(await notify.expireStaleLinkTokens()).toBeGreaterThan(0);
    } finally {
      await db.execute(sql`delete from users where id = ${user.id}::uuid`);
    }
  });

  test('telegram deep links are stored hashed and are one-time', async () => {
    const authRepo = createAuthRepo(db);
    const notify = createNotifyRepo(db);
    const email = `tg-${crypto.randomUUID()}@example.test`;
    const user = await authRepo.createUser({ email, name: null, passwordHash: 'x' });
    const raw = randomToken(16);

    try {
      await notify.createTelegramLink(user.id, hashToken(raw), new Date(Date.now() + 60_000));
      expect(await notify.consumeTelegramLink(raw, 42)).toBeNull();
      expect(await notify.consumeTelegramLink(hashToken(raw), 42)).toBe(user.id);
      expect(await notify.consumeTelegramLink(hashToken(raw), 42)).toBeNull();
    } finally {
      await db.execute(sql`delete from users where id = ${user.id}::uuid`);
    }
  });
});
