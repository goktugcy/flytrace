import { beforeEach, describe, expect, test } from 'bun:test';
import { fixedClock } from '@flytrace/shared';
import { type CodeHasher, normalizeCode } from './backup-codes.ts';
import {
  type BackupCodeRecord,
  type MfaRepo,
  MfaService,
  type UserMfaRecord,
} from './mfa-service.ts';
import { totp } from './totp.ts';

/** In-memory MfaRepo fake — mirrors the drizzle impl's contract. */
function createFakeRepo(): MfaRepo & {
  _mfa: Map<string, UserMfaRecord>;
  _codes: Map<string, Array<BackupCodeRecord & { userId: string; usedAt: Date | null }>>;
} {
  const mfa = new Map<string, UserMfaRecord>();
  const codes = new Map<
    string,
    Array<BackupCodeRecord & { userId: string; usedAt: Date | null }>
  >();
  let seq = 0;
  return {
    _mfa: mfa,
    _codes: codes,
    async getUserMfa(userId) {
      return mfa.get(userId) ?? null;
    },
    async upsertSecret(userId, secret) {
      mfa.set(userId, { userId, secret, enabled: false, confirmedAt: null });
    },
    async setEnabled(userId, confirmedAt) {
      const rec = mfa.get(userId);
      if (rec) mfa.set(userId, { ...rec, enabled: true, confirmedAt });
    },
    async deleteMfa(userId) {
      mfa.delete(userId);
      codes.delete(userId);
    },
    async replaceBackupCodes(userId, codeHashes) {
      codes.set(
        userId,
        codeHashes.map((codeHash) => ({
          id: `c${seq++}`,
          userId,
          codeHash,
          usedAt: null,
        })),
      );
    },
    async listActiveBackupCodes(userId) {
      return (codes.get(userId) ?? [])
        .filter((c) => c.usedAt === null)
        .map((c) => ({ id: c.id, codeHash: c.codeHash }));
    },
    async markBackupCodeUsed(id, usedAt) {
      for (const list of codes.values()) {
        const found = list.find((c) => c.id === id);
        if (found && found.usedAt === null) {
          found.usedAt = usedAt;
          return true;
        }
      }
      return false;
    },
  };
}

// Fast reversible fake hasher (production uses scrypt).
const fakeHasher: CodeHasher = {
  hash: async (c) => `h:${normalizeCode(c)}`,
  verify: async (c, h) => h === `h:${normalizeCode(c)}`,
};

const USER = 'user-1';
const NOW_MS = 1_700_000_000_000;

function makeService(repo: MfaRepo) {
  const clock = fixedClock(NOW_MS);
  const service = new MfaService({ repo, clock, hasher: fakeHasher, issuer: 'FlyTrace' });
  return { service, clock };
}

describe('MfaService enrol → confirm → verify → disable', () => {
  let repo: ReturnType<typeof createFakeRepo>;
  beforeEach(() => {
    repo = createFakeRepo();
  });

  test('beginEnrollment stores an unconfirmed secret + returns otpauth URI', async () => {
    const { service } = makeService(repo);
    const { secret, otpauthUri } = await service.beginEnrollment(USER, 'a@b.com');
    expect(secret.length).toBeGreaterThan(0);
    expect(otpauthUri).toContain('otpauth://totp/');
    const rec = repo._mfa.get(USER);
    expect(rec?.enabled).toBe(false);
    expect(rec?.secret).toBe(secret);
  });

  test('confirmEnrollment enables MFA and issues backup codes', async () => {
    const { service, clock } = makeService(repo);
    const { secret } = await service.beginEnrollment(USER);
    const token = totp(secret, { t: Math.floor(clock.now() / 1000) });

    const { backupCodes } = await service.confirmEnrollment(USER, token);
    expect(backupCodes.length).toBe(10);
    expect(repo._mfa.get(USER)?.enabled).toBe(true);
    expect(repo._mfa.get(USER)?.confirmedAt).toBeInstanceOf(Date);
    expect(repo._codes.get(USER)?.length).toBe(10);
  });

  test('confirmEnrollment rejects a bad token', async () => {
    const { service } = makeService(repo);
    await service.beginEnrollment(USER);
    await expect(service.confirmEnrollment(USER, '000000')).rejects.toThrow(/invalid TOTP/);
    expect(repo._mfa.get(USER)?.enabled).toBe(false);
  });

  test('confirmEnrollment fails when no enrolment is in progress', async () => {
    const { service } = makeService(repo);
    await expect(service.confirmEnrollment(USER, '123456')).rejects.toThrow(/no MFA enrolment/);
  });

  test('verify accepts a valid TOTP token', async () => {
    const { service, clock } = makeService(repo);
    const { secret } = await service.beginEnrollment(USER);
    await service.confirmEnrollment(USER, totp(secret, { t: Math.floor(clock.now() / 1000) }));

    const token = totp(secret, { t: Math.floor(clock.now() / 1000) });
    expect(await service.verify(USER, token)).toBe('totp');
  });

  test('verify accepts a backup code once, then rejects reuse (one-time)', async () => {
    const { service, clock } = makeService(repo);
    const { secret } = await service.beginEnrollment(USER);
    const { backupCodes } = await service.confirmEnrollment(
      USER,
      totp(secret, { t: Math.floor(clock.now() / 1000) }),
    );
    const code = backupCodes[0]!;

    expect(await service.verify(USER, code)).toBe('backup_code');
    expect(repo._codes.get(USER)?.filter((c) => c.usedAt === null).length).toBe(9);
    await expect(service.verify(USER, code)).rejects.toThrow(/invalid MFA code/);
  });

  test('verify rejects a backup code if another caller already consumed it', async () => {
    const { service, clock } = makeService(repo);
    const { secret } = await service.beginEnrollment(USER);
    const { backupCodes } = await service.confirmEnrollment(
      USER,
      totp(secret, { t: Math.floor(clock.now() / 1000) }),
    );
    const firstActive = await repo.listActiveBackupCodes(USER);
    await repo.markBackupCodeUsed(firstActive[0]!.id, new Date(clock.now()));

    await expect(service.verify(USER, backupCodes[0]!)).rejects.toThrow(/invalid MFA code/);
  });

  test('verify rejects a nonsense code and errors when MFA is not enabled', async () => {
    const { service, clock } = makeService(repo);
    await service.beginEnrollment(USER);
    // Not yet confirmed → not enabled.
    await expect(service.verify(USER, '123456')).rejects.toThrow(/not enabled/);

    await service.confirmEnrollment(
      USER,
      totp(repo._mfa.get(USER)!.secret, {
        t: Math.floor(clock.now() / 1000),
      }),
    );
    await expect(service.verify(USER, 'ZZZZ-9999')).rejects.toThrow(/invalid MFA code/);
  });

  test('disable removes all MFA state', async () => {
    const { service, clock } = makeService(repo);
    const { secret } = await service.beginEnrollment(USER);
    await service.confirmEnrollment(USER, totp(secret, { t: Math.floor(clock.now() / 1000) }));

    await service.disable(USER);
    expect(repo._mfa.get(USER)).toBeUndefined();
    expect(repo._codes.get(USER)).toBeUndefined();
    await expect(service.verify(USER, '123456')).rejects.toThrow(/not enabled/);
  });

  test('regenerateBackupCodes replaces old active codes', async () => {
    const { service, clock } = makeService(repo);
    const { secret } = await service.beginEnrollment(USER);
    const first = await service.confirmEnrollment(
      USER,
      totp(secret, { t: Math.floor(clock.now() / 1000) }),
    );

    const second = await service.regenerateBackupCodes(USER);
    expect(second.backupCodes).toHaveLength(10);
    expect(second.backupCodes).not.toEqual(first.backupCodes);
    expect(repo._codes.get(USER)).toHaveLength(10);
  });
});
