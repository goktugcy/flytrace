import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { loadRootEnv } from '@flytrace/shared';
import { sql } from 'drizzle-orm';
import { type Database, createDb } from '../index.ts';
import { users } from '../schema/auth.ts';
import {
  createAesGcmMfaSecretCodec,
  createSecurityAuditRepo,
  createSecurityDeviceRepo,
  createSecurityMfaRepo,
  createSecurityRefreshTokenRepo,
} from './security.ts';

loadRootEnv();

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

let db: Database;
let closeDb: (() => Promise<void>) | undefined;

async function createUser(emailPrefix: string): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ email: `${emailPrefix}-${crypto.randomUUID()}@example.test` })
    .returning({ id: users.id });
  return row!.id;
}

beforeAll(() => {
  if (!databaseUrl) return;
  const created = createDb({ url: databaseUrl, max: 1 });
  db = created.db;
  closeDb = created.close;
});

afterAll(async () => {
  await closeDb?.();
});

describeDb('security repositories (postgres integration)', () => {
  test('MFA repo encrypts secrets and consumes backup codes atomically', async () => {
    const userId = await createUser('mfa');
    const codec = createAesGcmMfaSecretCodec('integration-test-key-material');
    const repo = createSecurityMfaRepo(db, codec);

    try {
      await repo.upsertSecret(userId, 'BASE32SECRET');
      const raw = (await db.execute(sql`
        select secret_ciphertext as "secretCiphertext"
        from user_mfa
        where user_id = ${userId}
      `)) as unknown as { secretCiphertext: string }[];
      expect(raw[0]?.secretCiphertext.startsWith('v1:')).toBe(true);
      expect(raw[0]?.secretCiphertext).not.toBe('BASE32SECRET');

      const record = await repo.getUserMfa(userId);
      expect(record?.secret).toBe('BASE32SECRET');
      expect(record?.enabled).toBe(false);

      await repo.setEnabled(userId, new Date('2026-01-01T00:00:00.000Z'));
      await repo.replaceBackupCodes(userId, ['hash-1', 'hash-2']);
      const active = await repo.listActiveBackupCodes(userId);
      expect(active.map((c) => c.codeHash).sort()).toEqual(['hash-1', 'hash-2']);

      expect(await repo.markBackupCodeUsed(active[0]!.id, new Date())).toBe(true);
      expect(await repo.markBackupCodeUsed(active[0]!.id, new Date())).toBe(false);
      expect(await repo.listActiveBackupCodes(userId)).toHaveLength(1);
    } finally {
      await db.execute(sql`delete from users where id = ${userId}`);
    }
  });

  test('device and refresh-token repos enforce dedupe and rotation guards', async () => {
    const userId = await createUser('session');
    const devices = createSecurityDeviceRepo(db);
    const tokens = createSecurityRefreshTokenRepo(db);

    try {
      const now = new Date('2026-01-01T00:00:00.000Z');
      const deviceId = await devices.insert({
        userId,
        fingerprint: 'fp-a',
        ua: 'UA/1',
        lastIp: '203.0.113.10',
        trusted: false,
        lastSeenAt: now,
        createdAt: now,
      });
      const sameDeviceId = await devices.insert({
        userId,
        fingerprint: 'fp-a',
        ua: 'UA/1',
        lastIp: '203.0.113.11',
        trusted: false,
        lastSeenAt: new Date('2026-01-01T00:00:05.000Z'),
        createdAt: now,
      });
      expect(sameDeviceId).toBe(deviceId);
      expect(await devices.listByUser(userId)).toHaveLength(1);

      const firstId = await tokens.insert({
        userId,
        deviceId,
        tokenHash: `hash-${crypto.randomUUID()}`,
        familyId: 'family-a',
        expiresAt: new Date('2026-02-01T00:00:00.000Z'),
      });
      const secondId = await tokens.insert({
        userId,
        deviceId,
        tokenHash: `hash-${crypto.randomUUID()}`,
        familyId: 'family-a',
        expiresAt: new Date('2026-02-01T00:00:00.000Z'),
      });

      expect(await tokens.markReplaced(firstId, secondId, new Date())).toBe(true);
      expect(await tokens.markReplaced(firstId, crypto.randomUUID(), new Date())).toBe(false);
      await tokens.revokeFamily('family-a', new Date());
      expect((await tokens.findByHash((await tokenHashFor(secondId))!))?.revokedAt).not.toBeNull();

      const deviceOnlyId = await tokens.insert({
        userId,
        deviceId,
        tokenHash: `hash-${crypto.randomUUID()}`,
        familyId: 'family-b',
        expiresAt: new Date('2026-02-01T00:00:00.000Z'),
      });
      await tokens.revokeAllForDevice(deviceId, new Date());
      expect(
        (await tokens.findByHash((await tokenHashFor(deviceOnlyId))!))?.revokedAt,
      ).not.toBeNull();
    } finally {
      await db.execute(sql`delete from users where id = ${userId}`);
    }
  });

  test('security audit repo writes and filters newest-first', async () => {
    const repo = createSecurityAuditRepo(db);
    const action = `test.audit.${crypto.randomUUID()}`;
    const actorId = crypto.randomUUID();

    try {
      await repo.insert({
        id: crypto.randomUUID(),
        actorId,
        action,
        target: 'user:test',
        ip: '127.0.0.1',
        meta: { ok: true },
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      await repo.insert({
        id: crypto.randomUUID(),
        actorId,
        action,
        target: 'user:test',
        ip: '127.0.0.1',
        meta: { ok: true },
        createdAt: '2026-01-01T00:00:01.000Z',
      });

      const rows = await repo.query({ actorId, action, limit: 5 });
      expect(rows).toHaveLength(2);
      expect(rows[0]!.createdAt).toBe('2026-01-01T00:00:01.000Z');
      expect(rows[0]!.ip).toBe('127.0.0.1');
    } finally {
      await db.execute(sql`delete from audit_log where action = ${action}`);
    }
  });
});

async function tokenHashFor(id: string): Promise<string | null> {
  const rows = (await db.execute(sql`
    select token_hash as "tokenHash"
    from refresh_tokens
    where id = ${id}
    limit 1
  `)) as unknown as { tokenHash: string }[];
  return rows[0]?.tokenHash ?? null;
}
