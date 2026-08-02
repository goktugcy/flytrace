/**
 * Login-time MFA challenge (docs/15 §7a).
 *
 * A challenge is the short-lived receipt for "this request proved the password
 * but is not yet a session". It exists so that `POST /api/auth/sign-in` can stop
 * minting a session the moment a password matches: with MFA enabled the caller
 * gets a challenge token instead, and only a successful TOTP/backup-code
 * verification converts it into a real session.
 *
 * Storage rules
 * -------------
 * - The raw challenge token is a 256-bit CSPRNG value returned to the client
 *   ONCE. Only its SHA-256 digest is used as the storage key, so neither Redis
 *   nor a log/`MONITOR` capture yields a usable credential.
 * - Redis is the production backend so a challenge issued by one API instance
 *   can be completed by another. `MFA_CHALLENGE_BACKEND=memory` exists for
 *   local/test only and is REJECTED at boot in production — see
 *   `resolveMfaChallengeStore`. There is deliberately no silent fallback: if
 *   Redis is unreachable in production, sign-in fails closed (503) rather than
 *   degrading to a store other instances cannot see.
 * - Single use is enforced by an atomic delete whose return value decides the
 *   winner, and concurrent attempts on one challenge are serialised by a short
 *   lease. Together those close both the replay and the parallel-verify races.
 */
import { AppError, type Clock, type MinimalLogger, hashToken, randomToken } from '@flytrace/shared';

/** Stored state for one in-flight challenge. Never contains the raw token. */
export interface MfaChallengeRecord {
  userId: string;
  attempts: number;
  expiresAtMs: number;
}

/** Release handle for an exclusive verification lease. */
export type LockRelease = () => Promise<void>;

/**
 * Persistence port. `id` is always the SHA-256 digest of the challenge token —
 * implementations never see the raw value.
 */
export interface MfaChallengeStore {
  create(id: string, rec: MfaChallengeRecord, ttlMs: number): Promise<void>;
  get(id: string): Promise<MfaChallengeRecord | null>;
  /** Atomically increment the attempt counter; null when the challenge is gone. */
  recordAttempt(id: string): Promise<number | null>;
  /** Atomically remove. True ONLY for the caller that actually removed it. */
  consume(id: string): Promise<boolean>;
  /** Exclusive lease for one verification attempt; null when already held. */
  acquireLock(id: string, ttlMs: number): Promise<LockRelease | null>;
}

/** Narrow Redis surface — satisfied by ioredis, trivially faked in tests. */
export interface MfaChallengeRedis {
  hset(key: string, values: Record<string, string>): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  hincrby(key: string, field: string, increment: number): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  del(key: string): Promise<number>;
  set(key: string, value: string, mode: 'PX', ttl: number, condition: 'NX'): Promise<'OK' | null>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

/** Compare-and-delete so a lease that already expired cannot free a newer one. */
const UNLOCK_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export class RedisMfaChallengeStore implements MfaChallengeStore {
  constructor(
    private readonly redis: MfaChallengeRedis,
    private readonly prefix: string,
  ) {}

  private key(id: string): string {
    return `${this.prefix}mfa:chal:${id}`;
  }

  private lockKey(id: string): string {
    return `${this.prefix}mfa:chal:lock:${id}`;
  }

  async create(id: string, rec: MfaChallengeRecord, ttlMs: number): Promise<void> {
    const key = this.key(id);
    await this.redis.hset(key, {
      uid: rec.userId,
      att: String(rec.attempts),
      exp: String(rec.expiresAtMs),
    });
    // TTL is the hard backstop: Redis reclaims the key even if nothing consumes it.
    await this.redis.pexpire(key, ttlMs);
  }

  async get(id: string): Promise<MfaChallengeRecord | null> {
    const raw = await this.redis.hgetall(this.key(id));
    const userId = raw?.uid;
    if (!userId) return null;
    return {
      userId,
      attempts: Number(raw.att ?? 0),
      expiresAtMs: Number(raw.exp ?? 0),
    };
  }

  async recordAttempt(id: string): Promise<number | null> {
    const key = this.key(id);
    const current = await this.redis.hgetall(key);
    if (!current?.uid) return null;
    return this.redis.hincrby(key, 'att', 1);
  }

  async consume(id: string): Promise<boolean> {
    return (await this.redis.del(this.key(id))) > 0;
  }

  async acquireLock(id: string, ttlMs: number): Promise<LockRelease | null> {
    const key = this.lockKey(id);
    const fence = randomToken(16);
    const ok = await this.redis.set(key, fence, 'PX', ttlMs, 'NX');
    if (ok !== 'OK') return null;
    return async () => {
      await this.redis.eval(UNLOCK_SCRIPT, 1, key, fence).catch(() => 0);
    };
  }
}

/**
 * Process-local store for local development and tests. NOT valid in production:
 * a challenge issued by one instance would be invisible to the next, so a
 * multi-instance deployment would randomly reject correct codes.
 */
export class InMemoryMfaChallengeStore implements MfaChallengeStore {
  private readonly rows = new Map<string, { rec: MfaChallengeRecord; expiresAtMs: number }>();
  private readonly locks = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  private sweep(): void {
    const t = this.now();
    for (const [id, row] of this.rows) if (row.expiresAtMs <= t) this.rows.delete(id);
    for (const [id, until] of this.locks) if (until <= t) this.locks.delete(id);
  }

  async create(id: string, rec: MfaChallengeRecord, ttlMs: number): Promise<void> {
    this.sweep();
    this.rows.set(id, { rec: { ...rec }, expiresAtMs: this.now() + ttlMs });
  }

  async get(id: string): Promise<MfaChallengeRecord | null> {
    this.sweep();
    const row = this.rows.get(id);
    return row ? { ...row.rec } : null;
  }

  async recordAttempt(id: string): Promise<number | null> {
    this.sweep();
    const row = this.rows.get(id);
    if (!row) return null;
    row.rec.attempts += 1;
    return row.rec.attempts;
  }

  async consume(id: string): Promise<boolean> {
    this.sweep();
    return this.rows.delete(id);
  }

  async acquireLock(id: string, ttlMs: number): Promise<LockRelease | null> {
    this.sweep();
    if (this.locks.has(id)) return null;
    this.locks.set(id, this.now() + ttlMs);
    return async () => {
      this.locks.delete(id);
    };
  }

  /** Test helper. */
  size(): number {
    this.sweep();
    return this.rows.size;
  }
}

export interface MfaChallengeConfig {
  MFA_CHALLENGE_BACKEND: 'redis' | 'memory';
  APP_ENV: string;
}

export interface MfaChallengeStoreDeps {
  redis?: MfaChallengeRedis | undefined;
  prefix?: string | undefined;
  now?: (() => number) | undefined;
  logger?: MinimalLogger | undefined;
}

/**
 * Composition root for the challenge store. Fails LOUDLY on any configuration
 * that would be unsafe in production rather than degrading silently — an MFA
 * store that other instances cannot read is an availability *and* a security
 * problem (users get locked out; operators disable MFA to cope).
 */
export function resolveMfaChallengeStore(
  cfg: MfaChallengeConfig,
  deps: MfaChallengeStoreDeps = {},
): MfaChallengeStore {
  const isProduction = cfg.APP_ENV === 'production';

  if (cfg.MFA_CHALLENGE_BACKEND === 'redis') {
    if (deps.redis) {
      deps.logger?.info?.('mfa-challenge: using "redis" store');
      return new RedisMfaChallengeStore(deps.redis, deps.prefix ?? '');
    }
    if (isProduction) {
      throw new Error(
        'MFA_CHALLENGE_BACKEND=redis but no Redis client is available — refusing to start with a process-local MFA store in production',
      );
    }
    deps.logger?.warn(
      'mfa-challenge: MFA_CHALLENGE_BACKEND=redis with no Redis client — falling back to the in-memory store (permitted outside production only)',
    );
    return new InMemoryMfaChallengeStore(deps.now);
  }

  if (isProduction) {
    throw new Error(
      'MFA_CHALLENGE_BACKEND=memory is not permitted in production — a process-local MFA store breaks multi-instance sign-in',
    );
  }
  deps.logger?.info?.('mfa-challenge: using "memory" store');
  return new InMemoryMfaChallengeStore(deps.now);
}

export interface MfaChallengeServiceDeps {
  store: MfaChallengeStore;
  clock: Clock;
  /** Challenge lifetime. Clamped to 1–10 minutes. */
  ttlMs: number;
  /** Failed verifications tolerated before the challenge is burned. */
  maxAttempts: number;
  /** How long one verification attempt may hold the challenge. */
  lockTtlMs?: number | undefined;
  genToken?: (() => string) | undefined;
}

export interface IssuedChallenge {
  /** The raw token — returned to the client once, never stored or logged. */
  token: string;
  expiresAt: Date;
  expiresInSeconds: number;
}

/** Outcome of a successful challenge completion. */
export interface CompletedChallenge<T> {
  userId: string;
  result: T;
}

const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 600_000;
const DEFAULT_LOCK_TTL_MS = 10_000;

export class MfaChallengeService {
  private readonly ttlMs: number;
  private readonly maxAttempts: number;
  private readonly lockTtlMs: number;
  private readonly genToken: () => string;

  constructor(private readonly deps: MfaChallengeServiceDeps) {
    this.ttlMs = Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, deps.ttlMs));
    this.maxAttempts = Math.max(1, deps.maxAttempts);
    this.lockTtlMs = deps.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;
    this.genToken = deps.genToken ?? (() => randomToken());
  }

  /** Mint a challenge for a user who has proved their password. */
  async issue(userId: string): Promise<IssuedChallenge> {
    const token = this.genToken();
    const now = this.deps.clock.now();
    const expiresAtMs = now + this.ttlMs;
    await this.deps.store.create(
      hashToken(token),
      { userId, attempts: 0, expiresAtMs },
      this.ttlMs,
    );
    return {
      token,
      expiresAt: new Date(expiresAtMs),
      expiresInSeconds: Math.floor(this.ttlMs / 1000),
    };
  }

  /**
   * Redeem a challenge: run `verify` for the challenge's user and, only if it
   * resolves, atomically consume the challenge and return its result.
   *
   * Every rejection raises `UNAUTHENTICATED` with a message that does not
   * distinguish "unknown token" from "expired" from "already used" — a client
   * that did not create the challenge learns nothing from probing.
   *
   * @param expectedUserId when supplied, the challenge must belong to this user
   *        (defence in depth for flows that already know who is authenticating).
   */
  async complete<T>(
    token: string,
    verify: (userId: string) => Promise<T>,
    expectedUserId?: string,
  ): Promise<CompletedChallenge<T>> {
    const id = hashToken(token);
    const release = await this.deps.store.acquireLock(id, this.lockTtlMs);
    if (!release) {
      // A concurrent request already holds this challenge. Rejecting is the
      // safe answer: retrying is cheap, double-spending a backup code is not.
      throw new AppError('CONFLICT', 'this challenge is already being verified');
    }

    try {
      const record = await this.deps.store.get(id);
      if (!record) throw invalidChallenge();

      if (record.expiresAtMs <= this.deps.clock.now()) {
        await this.deps.store.consume(id);
        throw invalidChallenge();
      }

      // A challenge minted for someone else is never usable here.
      if (expectedUserId !== undefined && record.userId !== expectedUserId) {
        await this.deps.store.consume(id);
        throw invalidChallenge();
      }

      const attempts = await this.deps.store.recordAttempt(id);
      if (attempts === null) throw invalidChallenge();
      if (attempts > this.maxAttempts) {
        await this.deps.store.consume(id);
        throw new AppError('RATE_LIMITED', 'too many verification attempts');
      }

      const result = await verify(record.userId);

      // Single use: whoever wins the delete owns the challenge. A loser here
      // raced past the lock (e.g. after a lease expiry) and gets nothing.
      if (!(await this.deps.store.consume(id))) throw invalidChallenge();

      return { userId: record.userId, result };
    } finally {
      await release();
    }
  }

  /** Discard a challenge without completing it (e.g. MFA was disabled). */
  async discard(token: string): Promise<void> {
    await this.deps.store.consume(hashToken(token));
  }

  get challengeTtlMs(): number {
    return this.ttlMs;
  }
}

function invalidChallenge(): AppError {
  return new AppError('UNAUTHENTICATED', 'invalid or expired MFA challenge');
}
