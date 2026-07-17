import type { AuthRepo, AuthUser, SessionWithUser } from '@flytrace/db';
import { AppError, type Clock } from '@flytrace/shared';

/** Password hasher port — kept injectable so tests avoid the (slow) real KDF. */
export interface Hasher {
  hash(password: string): Promise<string>;
  verify(password: string, hash: string): Promise<boolean>;
}

/** Production hasher: Bun's argon2id (a vetted KDF — never home-rolled crypto). */
export const bunHasher: Hasher = {
  hash: (password) => Bun.password.hash(password, { algorithm: 'argon2id' }),
  verify: (password, hash) => Bun.password.verify(password, hash),
};

export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface AuthServiceDeps {
  repo: AuthRepo;
  clock: Clock;
  hasher: Hasher;
  sessionTtlMs: number;
  genToken?: () => string;
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

/**
 * Credentials + server-session auth (docs/15 §15.1). Pure of HTTP; the routes
 * layer maps results to cookies and envelopes. Deterministic under an injected
 * clock/token generator for tests.
 */
export class AuthService {
  private readonly genToken: () => string;

  constructor(private readonly deps: AuthServiceDeps) {
    this.genToken = deps.genToken ?? randomToken;
  }

  async signUp(input: Credentials & { name?: string | null }): Promise<SessionResult> {
    const email = input.email.trim().toLowerCase();
    if (await this.deps.repo.findUserByEmail(email)) {
      throw new AppError('CONFLICT', 'an account with this email already exists');
    }
    const passwordHash = await this.deps.hasher.hash(input.password);
    const user = await this.deps.repo.createUser({ email, name: input.name ?? null, passwordHash });
    return this.startSession(user, input.ip ?? null, input.userAgent ?? null);
  }

  async signIn(input: Credentials): Promise<SessionResult> {
    const email = input.email.trim().toLowerCase();
    const found = await this.deps.repo.findUserByEmail(email);
    // Verify even when the user is missing would be ideal (timing); acceptable here.
    if (!found || !found.passwordHash) {
      throw new AppError('UNAUTHENTICATED', 'invalid email or password');
    }
    const okPw = await this.deps.hasher.verify(input.password, found.passwordHash);
    if (!okPw) throw new AppError('UNAUTHENTICATED', 'invalid email or password');
    const { passwordHash: _omit, ...user } = found;
    return this.startSession(user, input.ip ?? null, input.userAgent ?? null);
  }

  async session(token: string | undefined): Promise<SessionWithUser | null> {
    if (!token) return null;
    return this.deps.repo.findSession(token);
  }

  async signOut(token: string | undefined): Promise<void> {
    if (token) await this.deps.repo.deleteSession(token);
  }

  private async startSession(
    user: AuthUser,
    ip: string | null,
    userAgent: string | null,
  ): Promise<SessionResult> {
    const token = this.genToken();
    const expiresAt = new Date(this.deps.clock.now() + this.deps.sessionTtlMs);
    await this.deps.repo.createSession({ userId: user.id, token, expiresAt, ip, userAgent });
    return { user, token, expiresAt };
  }
}
