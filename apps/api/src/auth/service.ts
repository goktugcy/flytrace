import type { AuthRepo, AuthUser, SessionWithUser } from '@flytrace/db';
import {
  AppError,
  type Clock,
  type TokenHasher,
  randomToken,
  sha256TokenHasher,
} from '@flytrace/shared';

/** Password hasher port — kept injectable so tests avoid the (slow) real KDF. */
export interface Hasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

/**
 * Production password hasher: Bun's argon2id (a vetted KDF — never home-rolled
 * crypto). This is for PASSWORDS ONLY. Opaque bearer tokens use the fast
 * deterministic digest in @flytrace/shared — see the note there on why the two
 * must never be swapped.
 */
export const bunHasher: Hasher = {
  hash: (password) => Bun.password.hash(password, { algorithm: 'argon2id' }),
  verify: (password, hash) => Bun.password.verify(password, hash),
};

export interface AuthServiceDeps {
  repo: AuthRepo;
  clock: Clock;
  hasher: Hasher;
  sessionTtlMs: number;
  genToken?: () => string;
  /** Deterministic at-rest digest for session tokens (SHA-256 by default). */
  tokenHasher?: TokenHasher;
}

export interface Credentials {
  email: string;
  password: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface SessionResult {
  user: AuthUser;
  token: string;
  expiresAt: Date;
}

/** Result of verifying credentials, before any session is minted. */
export interface VerifiedCredentials {
  user: AuthUser;
}

/**
 * Credentials + server-session auth (docs/15 §15.1). Pure of HTTP; the routes
 * layer maps results to cookies and envelopes. Deterministic under an injected
 * clock/token generator for tests.
 *
 * Session tokens are minted here and returned to the caller exactly once; only
 * their digest reaches the database. `signIn` deliberately does NOT create a
 * session — it only proves the credentials. Whether a session may be issued is
 * an MFA decision made one layer up (see `auth/sign-in-flow.ts`), which is what
 * keeps "password correct" and "fully authenticated" from collapsing into the
 * same step.
 */
export class AuthService {
  private readonly genToken: () => string;
  private readonly tokenHasher: TokenHasher;
  /** Lazily-built decoy hash for the timing-equalisation path (see below). */
  private decoyHash: Promise<string> | null = null;

  constructor(private readonly deps: AuthServiceDeps) {
    this.genToken = deps.genToken ?? (() => randomToken());
    this.tokenHasher = deps.tokenHasher ?? sha256TokenHasher;
  }

  /**
   * A valid hash of a value nobody knows, produced by the *same* hasher the
   * real path uses. Verifying against it on the "no such user" branch makes the
   * KDF cost — the dominant term in the response time — identical whether or
   * not the account exists, so the endpoint cannot be used to enumerate users.
   * Built once, on first miss, and reused.
   */
  private decoy(): Promise<string> {
    this.decoyHash ??= this.deps.hasher.hash(randomToken(16));
    return this.decoyHash;
  }

  async signUp(input: Credentials & { name?: string | null }): Promise<AuthUser> {
    const email = input.email.trim().toLowerCase();
    if (await this.deps.repo.findUserByEmail(email)) {
      throw new AppError('CONFLICT', 'an account with this email already exists');
    }
    const passwordHash = await this.deps.hasher.hash(input.password);
    return this.deps.repo.createUser({ email, name: input.name ?? null, passwordHash });
  }

  /**
   * Verify email + password. Throws `UNAUTHENTICATED` with an identical message
   * for "no such user" and "wrong password" so the endpoint cannot be used to
   * enumerate accounts. A dummy verify runs on the missing-user path to keep
   * response timing comparable.
   */
  async verifyCredentials(input: Credentials): Promise<VerifiedCredentials> {
    const email = input.email.trim().toLowerCase();
    const found = await this.deps.repo.findUserByEmail(email);
    if (!found || !found.passwordHash) {
      // Burn comparable time so a missing account is not detectable by latency.
      await this.deps.hasher.verify(input.password, await this.decoy()).catch(() => false);
      throw new AppError('UNAUTHENTICATED', 'invalid email or password');
    }
    const okPw = await this.deps.hasher.verify(input.password, found.passwordHash);
    if (!okPw) throw new AppError('UNAUTHENTICATED', 'invalid email or password');
    const { passwordHash: _omit, ...user } = found;
    return { user };
  }

  /**
   * Mint a session for an already-authenticated user. Callers must have either
   * verified credentials with no MFA requirement, or completed an MFA challenge.
   */
  async startSession(input: {
    user: AuthUser;
    ip?: string | null;
    userAgent?: string | null;
    deviceId?: string | null;
  }): Promise<SessionResult> {
    const token = this.genToken();
    const expiresAt = new Date(this.deps.clock.now() + this.deps.sessionTtlMs);
    await this.deps.repo.createSession({
      userId: input.user.id,
      tokenHash: this.tokenHasher.hash(token),
      expiresAt,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      deviceId: input.deviceId ?? null,
    });
    return { user: input.user, token, expiresAt };
  }

  /** Look a user up by id (used after an MFA challenge or a token rotation). */
  async findUser(userId: string): Promise<AuthUser | null> {
    return this.deps.repo.findUserById(userId);
  }

  async session(token: string | undefined): Promise<SessionWithUser | null> {
    if (!token) return null;
    return this.deps.repo.findSession(this.tokenHasher.hash(token));
  }

  async signOut(token: string | undefined): Promise<void> {
    if (token) await this.deps.repo.deleteSession(this.tokenHasher.hash(token));
  }

  /** Terminate every session for a user (global sign-out, credential change). */
  async signOutAll(userId: string): Promise<number> {
    return this.deps.repo.deleteSessionsForUser(userId);
  }

  /** Terminate sessions bound to a single device. */
  async signOutDevice(deviceId: string): Promise<number> {
    return this.deps.repo.deleteSessionsForDevice(deviceId);
  }
}
