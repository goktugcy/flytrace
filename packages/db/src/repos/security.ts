import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../index.ts';
import { auditLog } from '../schema/security-audit.ts';
import { mfaBackupCodes, userMfa } from '../schema/security-mfa.ts';
import { refreshTokens, userDevices } from '../schema/security-session.ts';

export interface MfaSecretCodec {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

const MFA_CIPHER_VERSION = 'v1';
const GCM_IV_BYTES = 12;

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function fromB64url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function requiredReturnedId(row: { id: string } | undefined, operation: string): string {
  if (!row) throw new Error(`${operation} did not return an id`);
  return row.id;
}

export function createAesGcmMfaSecretCodec(keyMaterial: string): MfaSecretCodec {
  if (keyMaterial.length < 16) {
    throw new Error('MFA secret encryption key must be at least 16 characters');
  }
  const key = createHash('sha256').update(keyMaterial).digest();
  return {
    encrypt(plaintext) {
      const iv = randomBytes(GCM_IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [MFA_CIPHER_VERSION, b64url(iv), b64url(tag), b64url(encrypted)].join(':');
    },
    decrypt(ciphertext) {
      const [version, iv64, tag64, encrypted64] = ciphertext.split(':');
      if (version !== MFA_CIPHER_VERSION || !iv64 || !tag64 || !encrypted64) {
        throw new Error('unsupported MFA secret ciphertext envelope');
      }
      const decipher = createDecipheriv('aes-256-gcm', key, fromB64url(iv64));
      decipher.setAuthTag(fromB64url(tag64));
      return Buffer.concat([decipher.update(fromB64url(encrypted64)), decipher.final()]).toString(
        'utf8',
      );
    },
  };
}

export interface DbUserMfaRecord {
  userId: string;
  secret: string;
  enabled: boolean;
  confirmedAt: Date | null;
}

export interface DbBackupCodeRecord {
  id: string;
  codeHash: string;
}

export function createSecurityMfaRepo(db: Database, codec: MfaSecretCodec) {
  return {
    async getUserMfa(userId: string): Promise<DbUserMfaRecord | null> {
      const [row] = await db
        .select({
          userId: userMfa.userId,
          secretCiphertext: userMfa.secretCiphertext,
          enabled: userMfa.enabled,
          confirmedAt: userMfa.confirmedAt,
        })
        .from(userMfa)
        .where(eq(userMfa.userId, userId))
        .limit(1);
      if (!row) return null;
      return {
        userId: row.userId,
        secret: codec.decrypt(row.secretCiphertext),
        enabled: row.enabled,
        confirmedAt: row.confirmedAt,
      };
    },

    async upsertSecret(userId: string, secret: string): Promise<void> {
      await db
        .insert(userMfa)
        .values({
          userId,
          secretCiphertext: codec.encrypt(secret),
          enabled: false,
          confirmedAt: null,
        })
        .onConflictDoUpdate({
          target: userMfa.userId,
          set: {
            secretCiphertext: codec.encrypt(secret),
            enabled: false,
            confirmedAt: null,
          },
        });
    },

    async setEnabled(userId: string, confirmedAt: Date): Promise<void> {
      await db
        .update(userMfa)
        .set({ enabled: true, confirmedAt })
        .where(eq(userMfa.userId, userId));
    },

    async deleteMfa(userId: string): Promise<void> {
      await db.transaction(async (tx) => {
        await tx.delete(mfaBackupCodes).where(eq(mfaBackupCodes.userId, userId));
        await tx.delete(userMfa).where(eq(userMfa.userId, userId));
      });
    },

    async replaceBackupCodes(userId: string, codeHashes: string[]): Promise<void> {
      await db.transaction(async (tx) => {
        await tx.delete(mfaBackupCodes).where(eq(mfaBackupCodes.userId, userId));
        if (codeHashes.length > 0) {
          await tx
            .insert(mfaBackupCodes)
            .values(codeHashes.map((codeHash) => ({ userId, codeHash })));
        }
      });
    },

    async listActiveBackupCodes(userId: string): Promise<DbBackupCodeRecord[]> {
      return db
        .select({ id: mfaBackupCodes.id, codeHash: mfaBackupCodes.codeHash })
        .from(mfaBackupCodes)
        .where(and(eq(mfaBackupCodes.userId, userId), isNull(mfaBackupCodes.usedAt)));
    },

    async markBackupCodeUsed(id: string, usedAt: Date): Promise<boolean> {
      const rows = await db
        .update(mfaBackupCodes)
        .set({ usedAt })
        .where(and(eq(mfaBackupCodes.id, id), isNull(mfaBackupCodes.usedAt)))
        .returning({ id: mfaBackupCodes.id });
      return rows.length > 0;
    },
  };
}

export type SecurityMfaRepo = ReturnType<typeof createSecurityMfaRepo>;

export interface DbDeviceRecord {
  id: string;
  userId: string;
  fingerprint: string;
  ua: string | null;
  lastIp: string | null;
  trusted: boolean;
  lastSeenAt: Date;
  createdAt: Date;
}

export interface DbNewDevice {
  userId: string;
  fingerprint: string;
  ua: string | null;
  lastIp: string | null;
  trusted: boolean;
  lastSeenAt: Date;
  createdAt: Date;
}

export function createSecurityDeviceRepo(db: Database) {
  return {
    async findByFingerprint(userId: string, fingerprint: string): Promise<DbDeviceRecord | null> {
      const [row] = await db
        .select()
        .from(userDevices)
        .where(and(eq(userDevices.userId, userId), eq(userDevices.fingerprint, fingerprint)))
        .limit(1);
      return row ?? null;
    },

    async insert(rec: DbNewDevice): Promise<string> {
      const [row] = await db
        .insert(userDevices)
        .values(rec)
        .onConflictDoUpdate({
          target: [userDevices.userId, userDevices.fingerprint],
          set: {
            ua: rec.ua,
            lastIp: rec.lastIp,
            lastSeenAt: rec.lastSeenAt,
          },
        })
        .returning({ id: userDevices.id });
      return requiredReturnedId(row, 'user_devices insert');
    },

    async touch(id: string, lastSeenAt: Date, lastIp: string | null): Promise<void> {
      await db.update(userDevices).set({ lastSeenAt, lastIp }).where(eq(userDevices.id, id));
    },

    async listByUser(userId: string): Promise<DbDeviceRecord[]> {
      return db
        .select()
        .from(userDevices)
        .where(eq(userDevices.userId, userId))
        .orderBy(desc(userDevices.lastSeenAt));
    },

    async setTrusted(id: string, trusted: boolean): Promise<void> {
      await db.update(userDevices).set({ trusted }).where(eq(userDevices.id, id));
    },

    async remove(id: string): Promise<void> {
      await db.delete(userDevices).where(eq(userDevices.id, id));
    },
  };
}

export type SecurityDeviceRepo = ReturnType<typeof createSecurityDeviceRepo>;

export interface DbNewRefreshToken {
  userId: string;
  deviceId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
}

export interface DbRefreshTokenRecord extends DbNewRefreshToken {
  id: string;
  revokedAt: Date | null;
  replacedBy: string | null;
}

export function createSecurityRefreshTokenRepo(db: Database) {
  return {
    async insert(rec: DbNewRefreshToken): Promise<string> {
      const [row] = await db.insert(refreshTokens).values(rec).returning({ id: refreshTokens.id });
      return requiredReturnedId(row, 'refresh_tokens insert');
    },

    async findByHash(tokenHash: string): Promise<DbRefreshTokenRecord | null> {
      const [row] = await db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, tokenHash))
        .limit(1);
      return row ?? null;
    },

    async markReplaced(id: string, replacedBy: string, revokedAt: Date): Promise<boolean> {
      const rows = await db
        .update(refreshTokens)
        .set({ replacedBy, revokedAt })
        .where(and(eq(refreshTokens.id, id), isNull(refreshTokens.revokedAt)))
        .returning({ id: refreshTokens.id });
      return rows.length > 0;
    },

    async revoke(id: string, revokedAt: Date): Promise<void> {
      await db
        .update(refreshTokens)
        .set({ revokedAt })
        .where(and(eq(refreshTokens.id, id), isNull(refreshTokens.revokedAt)));
    },

    async revokeFamily(familyId: string, revokedAt: Date): Promise<void> {
      await db
        .update(refreshTokens)
        .set({ revokedAt })
        .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
    },

    async revokeAllForUser(userId: string, revokedAt: Date): Promise<void> {
      await db
        .update(refreshTokens)
        .set({ revokedAt })
        .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
    },

    async revokeAllForDevice(deviceId: string, revokedAt: Date): Promise<void> {
      await db
        .update(refreshTokens)
        .set({ revokedAt })
        .where(and(eq(refreshTokens.deviceId, deviceId), isNull(refreshTokens.revokedAt)));
    },
  };
}

export type SecurityRefreshTokenRepo = ReturnType<typeof createSecurityRefreshTokenRepo>;

export interface SecurityAuditEntry {
  id: string;
  actorId: string | null;
  action: string;
  target: string | null;
  ip: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

export interface SecurityAuditListFilter {
  actorId?: string | undefined;
  action?: string | undefined;
  limit?: number | undefined;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function createSecurityAuditRepo(db: Database) {
  return {
    async insert(entry: SecurityAuditEntry): Promise<void> {
      await db.insert(auditLog).values({
        id: entry.id,
        actorId: entry.actorId,
        action: entry.action,
        target: entry.target,
        ip: entry.ip,
        meta: entry.meta,
        createdAt: new Date(entry.createdAt),
      });
    },

    async query(filter: SecurityAuditListFilter): Promise<SecurityAuditEntry[]> {
      const actorId = filter.actorId ?? null;
      const action = filter.action ?? null;
      const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
      const rows = (await db.execute(sql`
        select id, actor_id as "actorId", action, target, host(ip) as ip, meta,
               created_at as "createdAt"
        from audit_log
        where (${actorId}::uuid is null or actor_id = ${actorId}::uuid)
          and (${action}::text is null or action = ${action})
        order by created_at desc
        limit ${limit}
      `)) as unknown as Array<{
        id: string;
        actorId: string | null;
        action: string;
        target: string | null;
        ip: string | null;
        meta: Record<string, unknown> | null;
        createdAt: Date | string;
      }>;
      return rows.map((row) => ({
        ...row,
        createdAt: iso(row.createdAt),
      }));
    },
  };
}

export type SecurityAuditRepo = ReturnType<typeof createSecurityAuditRepo>;
