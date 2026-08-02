/**
 * In-memory fakes for the auth stack, shared by the unit tests.
 *
 * The repo fake mirrors the real contract exactly on the point that matters:
 * it is handed a token HASH, never a raw token. A test can therefore assert
 * that no raw session token was ever persisted simply by inspecting
 * {@link InMemoryAuthRepo.storedTokenHashes}.
 */
import type { AuthRepo, AuthUser, SessionSummary, SessionWithUser } from '@flytrace/db';

interface StoredSession {
  id: string;
  userId: string;
  tokenHash: string;
  deviceId: string | null;
  ip: string | null;
  userAgent: string | null;
  expiresAt: Date;
  createdAt: Date;
}

export class InMemoryAuthRepo implements AuthRepo {
  private readonly usersByEmail = new Map<string, AuthUser & { passwordHash: string | null }>();
  private readonly sessions = new Map<string, StoredSession>();
  private seq = 0;
  /** Fixed "now" so expiry checks are deterministic; overridable per test. */
  now: () => number = () => Date.now();

  async findUserByEmail(email: string) {
    return this.usersByEmail.get(email) ?? null;
  }

  async findUserById(id: string): Promise<AuthUser | null> {
    const found = [...this.usersByEmail.values()].find((u) => u.id === id);
    if (!found) return null;
    const { passwordHash: _omit, ...user } = found;
    return user;
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

  async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
    for (const [email, user] of this.usersByEmail) {
      if (user.id === userId) this.usersByEmail.set(email, { ...user, passwordHash });
    }
  }

  async createSession(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    ip: string | null;
    userAgent: string | null;
    deviceId?: string | null;
  }): Promise<void> {
    this.seq += 1;
    this.sessions.set(input.tokenHash, {
      id: `s${this.seq}`,
      userId: input.userId,
      tokenHash: input.tokenHash,
      deviceId: input.deviceId ?? null,
      ip: input.ip,
      userAgent: input.userAgent,
      expiresAt: input.expiresAt,
      createdAt: new Date(this.now()),
    });
  }

  async findSession(tokenHash: string): Promise<SessionWithUser | null> {
    const row = this.sessions.get(tokenHash);
    if (!row || row.expiresAt.getTime() <= this.now()) return null;
    const user = await this.findUserById(row.userId);
    if (!user) return null;
    return {
      userId: row.userId,
      expiresAt: row.expiresAt.toISOString(),
      deviceId: row.deviceId,
      user,
    };
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash);
  }

  async deleteSessionsForUser(userId: string): Promise<number> {
    let n = 0;
    for (const [hash, row] of this.sessions) {
      if (row.userId === userId) {
        this.sessions.delete(hash);
        n += 1;
      }
    }
    return n;
  }

  async deleteSessionsForDevice(deviceId: string): Promise<number> {
    let n = 0;
    for (const [hash, row] of this.sessions) {
      if (row.deviceId === deviceId) {
        this.sessions.delete(hash);
        n += 1;
      }
    }
    return n;
  }

  async listSessionsForUser(userId: string): Promise<SessionSummary[]> {
    return [...this.sessions.values()]
      .filter((row) => row.userId === userId)
      .map((row) => ({
        id: row.id,
        deviceId: row.deviceId,
        ip: row.ip,
        userAgent: row.userAgent,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      }));
  }

  async deleteExpiredSessions(): Promise<number> {
    let n = 0;
    for (const [hash, row] of this.sessions) {
      if (row.expiresAt.getTime() <= this.now()) {
        this.sessions.delete(hash);
        n += 1;
      }
    }
    return n;
  }

  // ── test helpers ──

  /** Everything this repo has persisted in the token column. */
  get storedTokenHashes(): string[] {
    return [...this.sessions.keys()];
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  /** The IP values persisted alongside sessions (for data-minimisation tests). */
  get storedIps(): Array<string | null> {
    return [...this.sessions.values()].map((row) => row.ip);
  }
}
