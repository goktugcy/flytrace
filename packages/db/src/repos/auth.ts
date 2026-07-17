import { sql } from 'drizzle-orm';
import type { Database } from '../index.ts';
import { accounts, sessions, users } from '../schema/auth.ts';

/**
 * Auth persistence for the credentials session flow (docs/15 §15.1). Scoped to
 * the auth module. Passwords are stored hashed on the `accounts` row
 * (provider='credentials'); sessions are server-side rows referenced by a
 * cookie token. NOTE: this is a Better-Auth-compatible stand-in on the same
 * schema — swapping in Better Auth is localized to the api auth module.
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
  user: AuthUser;
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

    async createSession(input: {
      userId: string;
      token: string;
      expiresAt: Date;
      ip: string | null;
      userAgent: string | null;
    }): Promise<void> {
      await db.insert(sessions).values({
        userId: input.userId,
        token: input.token,
        expiresAt: input.expiresAt,
        ip: input.ip,
        userAgent: input.userAgent,
      });
    },

    async findSession(token: string): Promise<SessionWithUser | null> {
      const rows = (await db.execute(sql`
        select s.user_id as "userId", s.expires_at as "expiresAt",
               u.id as "uid", u.email, u.name, u.role
        from sessions s
        join users u on u.id = s.user_id
        where s.token = ${token} and s.expires_at > now()
        limit 1
      `)) as unknown as {
        userId: string;
        expiresAt: string;
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
        user: { id: r.uid, email: r.email, name: r.name, role: r.role },
      };
    },

    async deleteSession(token: string): Promise<void> {
      await db.delete(sessions).where(sql`${sessions.token} = ${token}`);
    },
  };
}

export type AuthRepo = ReturnType<typeof createAuthRepo>;
