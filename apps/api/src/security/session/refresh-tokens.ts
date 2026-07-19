import { createHash } from 'node:crypto';
import { AppError, type Clock } from '@flytrace/shared';

/**
 * Refresh-token rotation with reuse detection (docs §7b).
 *
 * Tokens are opaque and stored HASHED at rest via a fast, DETERMINISTIC digest
 * (so we can look a token up by its hash — argon2 would be wrong here). Every
 * `rotate` mints a new token in the same family and REVOKES the presented one.
 * Presenting an already-revoked token is treated as reuse: the whole rotation
 * family is revoked (a classic replay-defense) and the caller is rejected.
 */

/** Opaque-token generator port (32 random bytes hex in production). */
export type Random = () => string;

/** Deterministic token hasher port (NOT a password KDF). */
export interface TokenHasher {
  hash(token: string): string;
}

/** Production defaults — sha256 hex + CSPRNG. Injectable for deterministic tests. */
export const sha256TokenHasher: TokenHasher = {
  hash: (token) => createHash('sha256').update(token).digest('hex'),
};

export const randomToken: Random = () => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

export interface NewRefreshToken {
  userId: string;
  deviceId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
}

export interface RefreshTokenRecord extends NewRefreshToken {
  id: string;
  revokedAt: Date | null;
  replacedBy: string | null;
}

/**
 * Persistence port. Implementations must be atomic per-call; `insert` returns
 * the generated id so the service can link rotation lineage (`replaced_by`).
 */
export interface RefreshTokenRepo {
  insert(rec: NewRefreshToken): Promise<string>;
  findByHash(tokenHash: string): Promise<RefreshTokenRecord | null>;
  /** Revoke `id` and point its `replaced_by` at the successor token. False means race/reuse. */
  markReplaced(id: string, replacedBy: string, revokedAt: Date): Promise<boolean>;
  revoke(id: string, revokedAt: Date): Promise<void>;
  revokeFamily(familyId: string, revokedAt: Date): Promise<void>;
  revokeAllForUser(userId: string, revokedAt: Date): Promise<void>;
  revokeAllForDevice(deviceId: string, revokedAt: Date): Promise<void>;
}

export interface RefreshTokenServiceDeps {
  repo: RefreshTokenRepo;
  clock: Clock;
  random: Random;
  hasher: TokenHasher;
  /** Token lifetime in milliseconds. */
  ttlMs: number;
}

export interface IssuedToken {
  token: string;
  expiresAt: Date;
}

export class RefreshTokenService {
  constructor(private readonly deps: RefreshTokenServiceDeps) {}

  /** Issue a brand-new token, starting a fresh rotation family. */
  async issue(userId: string, deviceId: string): Promise<IssuedToken> {
    const token = this.deps.random();
    const familyId = this.deps.random();
    const expiresAt = new Date(this.deps.clock.now() + this.deps.ttlMs);
    await this.deps.repo.insert({
      userId,
      deviceId,
      tokenHash: this.deps.hasher.hash(token),
      familyId,
      expiresAt,
    });
    return { token, expiresAt };
  }

  /**
   * Rotate: validate the presented token, mint a successor in the same family,
   * and revoke the presented one. Reuse of an already-revoked token revokes the
   * entire family. Expired/unknown tokens are rejected.
   */
  async rotate(oldToken: string): Promise<IssuedToken> {
    const now = new Date(this.deps.clock.now());
    const rec = await this.deps.repo.findByHash(this.deps.hasher.hash(oldToken));
    if (!rec) throw new AppError('UNAUTHENTICATED', 'invalid refresh token');

    if (rec.revokedAt !== null) {
      // Reuse detected — a revoked token was replayed. Burn the whole family.
      await this.deps.repo.revokeFamily(rec.familyId, now);
      throw new AppError('UNAUTHENTICATED', 'refresh token reuse detected', {
        details: { familyId: rec.familyId, reuse: true },
      });
    }

    if (rec.expiresAt.getTime() <= now.getTime()) {
      await this.deps.repo.revoke(rec.id, now);
      throw new AppError('UNAUTHENTICATED', 'refresh token expired');
    }

    const token = this.deps.random();
    const newId = await this.deps.repo.insert({
      userId: rec.userId,
      deviceId: rec.deviceId,
      tokenHash: this.deps.hasher.hash(token),
      familyId: rec.familyId,
      expiresAt: new Date(now.getTime() + this.deps.ttlMs),
    });
    const replaced = await this.deps.repo.markReplaced(rec.id, newId, now);
    if (!replaced) {
      await this.deps.repo.revokeFamily(rec.familyId, now);
      throw new AppError('UNAUTHENTICATED', 'refresh token reuse detected', {
        details: { familyId: rec.familyId, reuse: true },
      });
    }
    return { token, expiresAt: new Date(now.getTime() + this.deps.ttlMs) };
  }

  /** Revoke a single token (best-effort; unknown tokens are a no-op). */
  async revoke(token: string): Promise<void> {
    const rec = await this.deps.repo.findByHash(this.deps.hasher.hash(token));
    if (rec && rec.revokedAt === null) {
      await this.deps.repo.revoke(rec.id, new Date(this.deps.clock.now()));
    }
  }

  /** Revoke every token for a user (global sign-out / credential change). */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.deps.repo.revokeAllForUser(userId, new Date(this.deps.clock.now()));
  }

  async revokeAllForDevice(deviceId: string): Promise<void> {
    await this.deps.repo.revokeAllForDevice(deviceId, new Date(this.deps.clock.now()));
  }
}

/**
 * In-memory RefreshTokenRepo for tests and the no-DB local default. Not for
 * production — state is process-local and unbounded.
 */
export function createInMemoryRefreshTokenRepo(idGen?: Random): RefreshTokenRepo {
  const rows = new Map<string, RefreshTokenRecord>();
  let seq = 0;
  const nextId = idGen ?? (() => `rt_${seq++}`);

  return {
    async insert(rec) {
      const id = nextId();
      rows.set(id, { ...rec, id, revokedAt: null, replacedBy: null });
      return id;
    },
    async findByHash(tokenHash) {
      for (const r of rows.values()) if (r.tokenHash === tokenHash) return { ...r };
      return null;
    },
    async markReplaced(id, replacedBy, revokedAt) {
      const r = rows.get(id);
      if (!r || r.revokedAt !== null) return false;
      rows.set(id, { ...r, replacedBy, revokedAt });
      return true;
    },
    async revoke(id, revokedAt) {
      const r = rows.get(id);
      if (r && r.revokedAt === null) rows.set(id, { ...r, revokedAt });
    },
    async revokeFamily(familyId, revokedAt) {
      for (const [id, r] of rows) {
        if (r.familyId === familyId && r.revokedAt === null) rows.set(id, { ...r, revokedAt });
      }
    },
    async revokeAllForUser(userId, revokedAt) {
      for (const [id, r] of rows) {
        if (r.userId === userId && r.revokedAt === null) rows.set(id, { ...r, revokedAt });
      }
    },
    async revokeAllForDevice(deviceId, revokedAt) {
      for (const [id, r] of rows) {
        if (r.deviceId === deviceId && r.revokedAt === null) rows.set(id, { ...r, revokedAt });
      }
    },
  };
}
