import {
  AppError,
  type Clock,
  type TokenHasher,
  randomToken as sharedRandomToken,
  sha256TokenHasher as sharedSha256TokenHasher,
} from '@flytrace/shared';

/**
 * Refresh-token rotation with reuse detection (docs §7b).
 *
 * Tokens are opaque and stored HASHED at rest via the shared, deterministic
 * digest in `@flytrace/shared` (so a token can be looked up by its hash —
 * argon2 would be wrong here, and is reserved for passwords). Every `rotate`
 * mints a successor in the same family and revokes the presented token, in a
 * single database transaction that row-locks the old token so two concurrent
 * refreshes cannot both succeed.
 *
 * Presenting an already-revoked token is reuse. There are two flavours:
 *
 *   - **Benign replay** — the same token re-submitted within `reuseGraceMs` of
 *     its rotation. That is what a double-clicked button, a retried fetch or a
 *     racing tab looks like; the client still holds the successor. We reject the
 *     request but leave the family intact, so an ordinary UI glitch does not
 *     sign the user out of everything.
 *   - **Real reuse** — a token replayed after the grace window. The successor
 *     has long been in use, so a second holder means the token leaked. The whole
 *     rotation family is burned and the caller is expected to escalate (revoke
 *     sessions, audit, notify).
 *
 * Set `REFRESH_TOKEN_REUSE_GRACE_MS=0` to disable the grace window entirely and
 * treat every replay as an attack.
 */

/** Opaque-token generator port (32 random bytes hex in production). */
export type Random = () => string;

export type { TokenHasher };

/** Production defaults, re-exported from the shared security module. */
export const sha256TokenHasher = sharedSha256TokenHasher;
export const randomToken: Random = () => sharedRandomToken();

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

/** Input for one atomic rotation step. */
export interface RefreshTokenRotation {
  oldTokenHash: string;
  newTokenHash: string;
  expiresAt: Date;
  now: Date;
}

export type RotateOutcome =
  | { status: 'rotated'; previous: RefreshTokenRecord; newId: string }
  | { status: 'not_found' }
  | { status: 'reuse'; previous: RefreshTokenRecord }
  | { status: 'expired'; previous: RefreshTokenRecord };

/**
 * Persistence port. Implementations must be atomic per-call; `rotate` in
 * particular must serialise concurrent callers presenting the same token.
 */
export interface RefreshTokenRepo {
  insert(rec: NewRefreshToken): Promise<string>;
  findByHash(tokenHash: string): Promise<RefreshTokenRecord | null>;
  rotate(input: RefreshTokenRotation): Promise<RotateOutcome>;
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
  /** Replays within this window of rotation are treated as benign retries. */
  reuseGraceMs?: number | undefined;
}

export interface IssuedToken {
  token: string;
  expiresAt: Date;
  userId: string;
  deviceId: string;
  familyId: string;
}

/**
 * Raised when a revoked token is replayed beyond the grace window. Carries the
 * blast radius so the caller can revoke sessions, audit and notify — without
 * ever echoing the token itself.
 */
export class RefreshTokenReuseError extends AppError {
  readonly userId: string;
  readonly familyId: string;
  readonly deviceId: string;

  constructor(input: { userId: string; familyId: string; deviceId: string }) {
    // The client-facing message is deliberately generic: it must not confirm
    // that the presented token was ever valid.
    super('UNAUTHENTICATED', 'invalid refresh token');
    this.name = 'RefreshTokenReuseError';
    this.userId = input.userId;
    this.familyId = input.familyId;
    this.deviceId = input.deviceId;
  }
}

const DEFAULT_REUSE_GRACE_MS = 10_000;

export class RefreshTokenService {
  private readonly reuseGraceMs: number;

  constructor(private readonly deps: RefreshTokenServiceDeps) {
    this.reuseGraceMs = deps.reuseGraceMs ?? DEFAULT_REUSE_GRACE_MS;
  }

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
    return { token, expiresAt, userId, deviceId, familyId };
  }

  /**
   * Rotate: atomically validate the presented token, mint a successor in the
   * same family, and revoke the presented one.
   *
   * @throws {RefreshTokenReuseError} on a replay past the grace window (family
   *   already burned by the time this throws).
   * @throws {AppError} `UNAUTHENTICATED` for unknown, expired, or
   *   within-grace-replayed tokens — all with the SAME message, so a caller
   *   cannot tell an unknown token from an expired one.
   */
  async rotate(oldToken: string): Promise<IssuedToken> {
    const now = new Date(this.deps.clock.now());
    const newToken = this.deps.random();

    const outcome = await this.deps.repo.rotate({
      oldTokenHash: this.deps.hasher.hash(oldToken),
      newTokenHash: this.deps.hasher.hash(newToken),
      expiresAt: new Date(now.getTime() + this.deps.ttlMs),
      now,
    });

    switch (outcome.status) {
      case 'rotated':
        return {
          token: newToken,
          expiresAt: new Date(now.getTime() + this.deps.ttlMs),
          userId: outcome.previous.userId,
          deviceId: outcome.previous.deviceId,
          familyId: outcome.previous.familyId,
        };

      case 'reuse': {
        const { previous } = outcome;
        const revokedAgoMs = previous.revokedAt
          ? now.getTime() - previous.revokedAt.getTime()
          : Number.POSITIVE_INFINITY;
        // Strict `<` so `reuseGraceMs = 0` disables the window entirely rather
        // than treating a same-millisecond replay as benign.
        if (revokedAgoMs < this.reuseGraceMs) {
          // In-flight retry: reject this request, keep the family alive.
          throw new AppError('UNAUTHENTICATED', 'invalid refresh token');
        }
        await this.deps.repo.revokeFamily(previous.familyId, now);
        throw new RefreshTokenReuseError({
          userId: previous.userId,
          familyId: previous.familyId,
          deviceId: previous.deviceId,
        });
      }

      case 'expired':
      case 'not_found':
        throw new AppError('UNAUTHENTICATED', 'invalid refresh token');
    }
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

  async revokeFamily(familyId: string): Promise<void> {
    await this.deps.repo.revokeFamily(familyId, new Date(this.deps.clock.now()));
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

  const findByHashSync = (tokenHash: string): RefreshTokenRecord | null => {
    for (const r of rows.values()) if (r.tokenHash === tokenHash) return r;
    return null;
  };

  return {
    async insert(rec) {
      const id = nextId();
      rows.set(id, { ...rec, id, revokedAt: null, replacedBy: null });
      return id;
    },
    async findByHash(tokenHash) {
      const found = findByHashSync(tokenHash);
      return found ? { ...found } : null;
    },
    // Single-threaded JS with no awaits inside gives this the same
    // all-or-nothing semantics the SQL transaction provides.
    async rotate(input) {
      const previous = findByHashSync(input.oldTokenHash);
      if (!previous) return { status: 'not_found' };
      if (previous.revokedAt !== null) return { status: 'reuse', previous: { ...previous } };
      if (previous.expiresAt.getTime() <= input.now.getTime()) {
        rows.set(previous.id, { ...previous, revokedAt: input.now });
        return { status: 'expired', previous: { ...previous } };
      }
      const newId = nextId();
      rows.set(newId, {
        id: newId,
        userId: previous.userId,
        deviceId: previous.deviceId,
        tokenHash: input.newTokenHash,
        familyId: previous.familyId,
        expiresAt: input.expiresAt,
        revokedAt: null,
        replacedBy: null,
      });
      rows.set(previous.id, { ...previous, revokedAt: input.now, replacedBy: newId });
      return { status: 'rotated', previous: { ...previous }, newId };
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
