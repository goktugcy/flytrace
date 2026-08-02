import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../index.ts';
import { accounts, sessions, users } from '../schema/auth.ts';

/**
 * Auth persistence for the credentials session flow (docs/15 §15.1). Scoped to
 * the auth module. Passwords are stored hashed on the `accounts` row
 * (provider='credentials').
 *
 * Sessions are server-side rows keyed by the SHA-256 digest of the cookie
 * token — this repo NEVER sees or stores the raw token; callers hash it with
 * `hashToken()` from @flytrace/shared first. That keeps a database dump free of
 * usable bearer credentials while retaining an indexed single-row lookup.
 */
export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
}

export interface UserWithSecret extends AuthUser {
  passwordHash: string | null;
}

export interface SessionWithUser {
  userId: string;
  expiresAt: string;
  deviceId: string | null;
  user: AuthUser;
}

export interface SessionSummary {
  id: string;
  deviceId: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
}

const CREDENTIALS = 'credentials';

export function createAuthRepo(db: Database) {
  return {
    async findUserByEmail(email: string): Promise<UserWithSecret | null> {
      const rows = (await db.execute(sql`
        select u.id, u.email, u.name, u.role, a.password_hash as "passwordHash"
        from users u
        left join accounts a on a.user_id = u.id and a.provider = ${CREDENTIALS}
        where u.email = ${email}
        limit 1
      `)) as unknown as UserWithSecret[];
      return rows[0] ?? null;
    },

    async findUserById(id: string): Promise<AuthUser | null> {
      const rows = (await db.execute(sql`
        select id, email, name, role from users where id = ${id}::uuid limit 1
      `)) as unknown as AuthUser[];
      return rows[0] ?? null;
    },

    /** Create a user + credentials account atomically. */
    async createUser(input: {
      email: string;
      name: string | null;
      passwordHash: string;
    }): Promise<AuthUser> {
      return db.transaction(async (tx) => {
        const [u] = await tx
          .insert(users)
          .values({ email: input.email, name: input.name })
          .returning({ id: users.id, email: users.email, name: users.name, role: users.role });
        const user = u as AuthUser;
        await tx.insert(accounts).values({
          userId: user.id,
          provider: CREDENTIALS,
          providerAccountId: input.email,
          passwordHash: input.passwordHash,
        });
        return user;
      });
    },

    /** Replace the credentials password hash (password change / reset). */
    async updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
      await db
        .update(accounts)
        .set({ passwordHash })
        .where(and(eq(accounts.userId, userId), eq(accounts.provider, CREDENTIALS)));
    },

    /** `tokenHash` is the SHA-256 digest of the cookie token, never the token. */
    async createSession(input: {
      userId: string;
      tokenHash: string;
      expiresAt: Date;
      ip: string | null;
      userAgent: string | null;
      deviceId?: string | null;
    }): Promise<void> {
      await db.insert(sessions).values({
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        ip: input.ip,
        userAgent: input.userAgent,
        deviceId: input.deviceId ?? null,
      });
    },

    async findSession(tokenHash: string): Promise<SessionWithUser | null> {
      const rows = (await db.execute(sql`
        select s.user_id as "userId", s.expires_at as "expiresAt", s.device_id as "deviceId",
               u.id as "uid", u.email, u.name, u.role
        from sessions s
        join users u on u.id = s.user_id
        where s.token_hash = ${tokenHash} and s.expires_at > now()
        limit 1
      `)) as unknown as {
        userId: string;
        expiresAt: string;
        deviceId: string | null;
        uid: string;
        email: string;
        name: string | null;
        role: string;
      }[];
      const r = rows[0];
      if (!r) return null;
      return {
        userId: r.userId,
        expiresAt: r.expiresAt,
        deviceId: r.deviceId,
        user: { id: r.uid, email: r.email, name: r.name, role: r.role },
      };
    },

    async deleteSession(tokenHash: string): Promise<void> {
      await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    },

    /** Global sign-out: drop every session row for the user. */
    async deleteSessionsForUser(userId: string): Promise<number> {
      const rows = (await db
        .delete(sessions)
        .where(eq(sessions.userId, userId))
        .returning({ id: sessions.id })) as { id: string }[];
      return rows.length;
    },

    /** Drop sessions bound to one device (device revoke). */
    async deleteSessionsForDevice(deviceId: string): Promise<number> {
      const rows = (await db
        .delete(sessions)
        .where(eq(sessions.deviceId, deviceId))
        .returning({ id: sessions.id })) as { id: string }[];
      return rows.length;
    },

    async listSessionsForUser(userId: string): Promise<SessionSummary[]> {
      const rows = (await db.execute(sql`
        select id, device_id as "deviceId", host(ip) as ip, user_agent as "userAgent",
               created_at as "createdAt", expires_at as "expiresAt"
        from sessions
        where user_id = ${userId}::uuid and expires_at > now()
        order by created_at desc
      `)) as unknown as SessionSummary[];
      return rows;
    },

    /** Housekeeping: reap sessions whose expiry has passed. */
    async deleteExpiredSessions(): Promise<number> {
      const rows = (await db
        .delete(sessions)
        .where(sql`${sessions.expiresAt} <= now()`)
        .returning({ id: sessions.id })) as { id: string }[];
      return rows.length;
    },
  };
}

export type AuthRepo = ReturnType<typeof createAuthRepo>;
