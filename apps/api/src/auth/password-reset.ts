/**
 * Forgotten-password reset (docs/18 §8.4).
 *
 * The flow is two endpoints with deliberately asymmetric behaviour:
 *
 *   request → ALWAYS reports success, whether or not the address exists
 *   consume → reports precisely one failure ("invalid or expired"), whatever
 *             actually went wrong
 *
 * Both shapes exist to keep the endpoint from answering "is this person a
 * user?". A request that 404s on unknown addresses turns the reset form into an
 * account-enumeration oracle, which is how credential-stuffing lists get
 * filtered down to real accounts before an attack even starts.
 *
 * The emailed link carries the only copy of the raw token; the database keeps
 * its SHA-256 digest, like every other bearer token in the platform.
 */
import { AppError, type Clock, type Logger, hashToken, randomToken } from '@flytrace/shared';
import type { AuditLog } from '../security/edge/audit-log.ts';
import { type IpStoragePolicy, applyIpPolicy } from '../security/session/ip.ts';
import type { RequestContext, SignInFlow } from './sign-in-flow.ts';

/** The slice of the auth repo this needs — keeps the service easy to fake. */
export interface PasswordResetRepo {
  findUserByEmail(
    email: string,
  ): Promise<{ id: string; email: string; passwordHash?: string | null } | null>;
  createPasswordResetToken(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    requestedIp: string | null;
  }): Promise<void>;
  consumePasswordResetToken(tokenHash: string): Promise<{ userId: string; email: string } | null>;
  updatePasswordHash(userId: string, passwordHash: string): Promise<void>;
}

/**
 * Delivery for the reset link.
 *
 * Deliberately NOT the SecurityNotifier: that fans out to a user's *verified*
 * notification endpoints, and someone who never verified their email would then
 * be permanently locked out. The reset mail goes to the account's own address.
 */
export interface PasswordResetMailer {
  sendResetLink(input: { email: string; url: string; expiresInMinutes: number }): Promise<void>;
}

/** The slice of the notifications transport this needs. */
export interface ResetEmailTransport {
  send(email: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<{ ok: boolean; status: number }>;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string,
  );
}

/**
 * Sends the reset link over the raw email transport.
 *
 * Deliberately not `EmailChannel`: that renders the flight-notification layout,
 * complete with an "Open flight" call to action and an unsubscribe footer
 * pointing at notification preferences. A password reset is transactional — it
 * must not be unsubscribable, and it must not look like a marketing mail.
 */
export class TransportPasswordResetMailer implements PasswordResetMailer {
  constructor(private readonly opts: { from: string; transport: ResetEmailTransport }) {}

  async sendResetLink(input: {
    email: string;
    url: string;
    expiresInMinutes: number;
  }): Promise<void> {
    const subject = 'Reset your FlyTrace password';
    const safeUrl = escapeHtml(input.url);
    const mins = input.expiresInMinutes;
    const html = `<h2>Reset your password</h2>
<p>Use the link below to choose a new password. It expires in ${mins} minutes and works once.</p>
<p><a href="${safeUrl}">Reset password</a></p>
<p style="color:#888;font-size:12px">If you did not request this, you can ignore this email —
your password stays unchanged. Resetting it signs you out on every device.</p>`;
    const text = `Reset your password

${input.url}

This link expires in ${mins} minutes and works once.
If you did not request it, ignore this email — your password stays unchanged.
`;
    const { ok, status } = await this.opts.transport.send({
      from: this.opts.from,
      to: input.email,
      subject,
      html,
      text,
    });
    if (!ok) throw new Error(`reset email failed with status ${status}`);
  }
}

/** Used when no email transport is configured — records instead of sending. */
export class NoopPasswordResetMailer implements PasswordResetMailer {
  readonly sent: Array<{ email: string; url: string }> = [];
  async sendResetLink(input: { email: string; url: string }): Promise<void> {
    this.sent.push({ email: input.email, url: input.url });
  }
}

export interface PasswordResetDeps {
  repo: PasswordResetRepo;
  mailer: PasswordResetMailer;
  audit: AuditLog;
  clock: Clock;
  logger: Logger;
  hashPassword: (password: string) => Promise<string>;
  /** Revokes every session and refresh token — the shared credential-change path. */
  flow: Pick<SignInFlow, 'revokeAllAfterCredentialChange'>;
  webBaseUrl: string;
  ttlMinutes: number;
  ipPolicy?: IpStoragePolicy | undefined;
}

export class PasswordResetService {
  constructor(private readonly deps: PasswordResetDeps) {}

  private storableIp(ip: string | null): string | null {
    return applyIpPolicy(ip, this.deps.ipPolicy ?? 'prefix');
  }

  private async record(
    action: string,
    actorId: string | undefined,
    ctx: RequestContext,
  ): Promise<void> {
    try {
      const ip = this.storableIp(ctx.ip);
      await this.deps.audit.record({
        ...(actorId ? { actorId, target: `user:${actorId}` } : {}),
        action,
        ...(ip ? { ip } : {}),
      });
    } catch (err) {
      this.deps.logger.error('audit write failed', { action, err: String(err) });
    }
  }

  /**
   * Start a reset. Resolves the same way for a known and an unknown address —
   * including taking no observable shortcut, since the caller returns a fixed
   * response either way.
   */
  async request(email: string, ctx: RequestContext): Promise<void> {
    const normalized = email.trim().toLowerCase();
    const user = await this.deps.repo.findUserByEmail(normalized);

    if (!user) {
      // Audited so a spray against many addresses is still visible to us, even
      // though the requester cannot tell the difference.
      await this.record('password.reset_requested_unknown', undefined, ctx);
      return;
    }

    const token = randomToken();
    const expiresAt = new Date(this.deps.clock.now() + this.deps.ttlMinutes * 60_000);
    await this.deps.repo.createPasswordResetToken({
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt,
      requestedIp: this.storableIp(ctx.ip),
    });

    const url = `${this.deps.webBaseUrl.replace(/\/$/, '')}/reset-password?token=${token}`;
    try {
      await this.deps.mailer.sendResetLink({
        email: user.email,
        url,
        expiresInMinutes: this.deps.ttlMinutes,
      });
    } catch (err) {
      // A delivery outage must not tell the caller whether the account exists,
      // so this is logged and swallowed rather than surfaced.
      this.deps.logger.error('password reset email failed', { err: String(err) });
    }
    await this.record('password.reset_requested', user.id, ctx);
  }

  /**
   * Finish a reset: claim the token, set the new password, and destroy every
   * existing credential.
   *
   * The revocation is the point. Whoever forced the reset — the legitimate
   * owner or an attacker who had already stolen a session — must not keep a
   * working session afterwards.
   */
  async reset(token: string, newPassword: string, ctx: RequestContext): Promise<void> {
    const claimed = await this.deps.repo.consumePasswordResetToken(hashToken(token));
    if (!claimed) {
      await this.record('password.reset_failed', undefined, ctx);
      // One message for unknown, expired, already-used and malformed alike.
      throw new AppError('UNAUTHENTICATED', 'invalid or expired reset link');
    }

    await this.deps.repo.updatePasswordHash(
      claimed.userId,
      await this.deps.hashPassword(newPassword),
    );
    await this.record('password.reset_completed', claimed.userId, ctx);
    await this.deps.flow.revokeAllAfterCredentialChange(claimed.userId, 'password_changed', ctx);
  }
}
