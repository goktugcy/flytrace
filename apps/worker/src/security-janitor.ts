import type { AuthRepo, NotifyRepo } from '@flytrace/db';
import type { Logger } from '@flytrace/shared';

/**
 * Periodic reaper for expired security rows (docs/18 §8.5).
 *
 * Expiry is already enforced at READ time — `findSession` filters on
 * `expires_at > now()`, and link-token lookups check their own expiry — so this
 * job is not a correctness control. It exists so the tables do not grow without
 * bound: every sign-in writes a session row with a 30-day life, and nothing
 * else ever deletes it. On a busy deployment that is the difference between an
 * index that stays in cache and one that does not.
 *
 * Deleting an expired session is also the point at which the last trace of a
 * dead credential leaves the database, which is worth doing on a schedule
 * rather than never.
 *
 * Safe to run on every worker replica: the statements are idempotent set-based
 * deletes, so a concurrent run simply finds fewer rows.
 */
export interface SecurityJanitorDeps {
  auth: Pick<AuthRepo, 'deleteExpiredSessions'>;
  notify: Pick<NotifyRepo, 'expireStaleLinkTokens'>;
  logger: Logger;
  intervalMs: number;
}

export class SecurityJanitor {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: SecurityJanitorDeps) {}

  /** Run one sweep. Never throws — a failed sweep must not kill the worker. */
  async runOnce(): Promise<{ sessions: number; linkTokens: number }> {
    let sessions = 0;
    let linkTokens = 0;
    try {
      sessions = await this.deps.auth.deleteExpiredSessions();
    } catch (err) {
      this.deps.logger.warn('session reap failed', { err: String(err) });
    }
    try {
      linkTokens = await this.deps.notify.expireStaleLinkTokens();
    } catch (err) {
      this.deps.logger.warn('link-token reap failed', { err: String(err) });
    }
    if (sessions > 0 || linkTokens > 0) {
      this.deps.logger.info('security janitor swept', { sessions, linkTokens });
    }
    return { sessions, linkTokens };
  }

  start(): void {
    if (this.timer) return;
    // Deliberately not run on boot: a rolling deploy would have every replica
    // issue the same DELETE at once. The first sweep lands one interval in.
    this.timer = setInterval(() => void this.runOnce(), this.deps.intervalMs);
    // Do not hold the process open for a housekeeping timer.
    this.timer.unref?.();
    this.deps.logger.info('security janitor started', { intervalMs: this.deps.intervalMs });
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
