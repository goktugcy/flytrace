import { beforeEach, describe, expect, test } from 'bun:test';
import { createLogger, hashToken, isAppError } from '@flytrace/shared';
import { InMemoryAuditLog } from '../security/edge/audit-log.ts';
import {
  NoopPasswordResetMailer,
  PasswordResetService,
  TransportPasswordResetMailer,
} from './password-reset.ts';
import { InMemoryAuthRepo } from './testing.ts';

const logger = createLogger({ level: 'error' });
const CTX = { ip: '203.0.113.7', userAgent: 'UA/1' };
const TTL_MINUTES = 60;

function make(nowMs = Date.UTC(2026, 0, 1), overrides: { failMail?: boolean } = {}) {
  const repo = new InMemoryAuthRepo();
  repo.now = () => nowMs;
  const clock = { now: () => nowMs, nowIso: () => new Date(nowMs).toISOString() };
  const mailer = new NoopPasswordResetMailer();
  const failing = {
    sent: [] as Array<{ email: string; url: string }>,
    async sendResetLink() {
      throw new Error('smtp down');
    },
  };
  const audit = new InMemoryAuditLog(clock);
  const revoked: Array<{ userId: string; reason: string }> = [];
  const service = new PasswordResetService({
    repo,
    mailer: overrides.failMail ? failing : mailer,
    audit,
    clock,
    logger,
    hashPassword: async (p) => `hashed:${p}`,
    flow: {
      async revokeAllAfterCredentialChange(userId: string, reason: string) {
        revoked.push({ userId, reason });
      },
    } as never,
    webBaseUrl: 'https://app.example.com',
    ttlMinutes: TTL_MINUTES,
  });
  return { repo, mailer, audit, service, revoked };
}

async function seedUser(repo: InMemoryAuthRepo, email = 'a@example.com') {
  return repo.createUser({ email, name: null, passwordHash: 'hashed:old-password' });
}

/** Pull the raw token out of the emailed link. */
function tokenFromLink(url: string): string {
  return new URL(url).searchParams.get('token') as string;
}

describe('PasswordResetService — request', () => {
  test('emails a link containing a token the database only holds hashed', async () => {
    const { repo, mailer, service } = make();
    const user = await seedUser(repo);

    await service.request('a@example.com', CTX);

    expect(mailer.sent).toHaveLength(1);
    const raw = tokenFromLink(mailer.sent[0]?.url as string);
    expect(raw.length).toBeGreaterThanOrEqual(32);

    // The raw value must be usable, and the stored form must not equal it.
    const claimed = await repo.consumePasswordResetToken(hashToken(raw));
    expect(claimed?.userId).toBe(user.id);
    expect(await repo.consumePasswordResetToken(raw)).toBeNull();
  });

  test('an unknown address is indistinguishable: no error, no email', async () => {
    const { mailer, service, audit } = make();
    // Must not throw — a 404 here would confirm which addresses have accounts.
    await service.request('nobody@example.com', CTX);
    expect(mailer.sent).toHaveLength(0);
    expect((await audit.list({})).map((e) => e.action)).toContain(
      'password.reset_requested_unknown',
    );
  });

  test('requesting again retires the previous link', async () => {
    const { repo, mailer, service } = make();
    await seedUser(repo);

    await service.request('a@example.com', CTX);
    const first = tokenFromLink(mailer.sent[0]?.url as string);
    await service.request('a@example.com', CTX);
    const second = tokenFromLink(mailer.sent[1]?.url as string);

    // Otherwise every request leaves another live token, so a link that leaked
    // hours ago still opens the account.
    expect(await repo.consumePasswordResetToken(hashToken(first))).toBeNull();
    expect(await repo.consumePasswordResetToken(hashToken(second))).not.toBeNull();
  });

  test('a delivery failure is swallowed, so it cannot reveal the account exists', async () => {
    const { repo, service, audit } = make(Date.UTC(2026, 0, 1), { failMail: true });
    await seedUser(repo);
    // Must resolve exactly like the success path — a thrown error here would
    // tell the caller the address belongs to a real account.
    await service.request('a@example.com', CTX);
    expect((await audit.list({})).map((e) => e.action)).toContain('password.reset_requested');
  });

  test('stores only the coarsened network of the requester', async () => {
    const { repo, service, audit } = make();
    await seedUser(repo);
    await service.request('a@example.com', CTX);
    const ips = (await audit.list({})).map((e) => e.ip);
    expect(ips).toContain('203.0.113.0/24');
    expect(ips).not.toContain('203.0.113.7');
  });
});

describe('PasswordResetService — reset', () => {
  let harness: ReturnType<typeof make>;
  let rawToken: string;

  beforeEach(async () => {
    harness = make();
    await seedUser(harness.repo);
    await harness.service.request('a@example.com', CTX);
    rawToken = tokenFromLink(harness.mailer.sent[0]?.url as string);
  });

  test('sets the new password and revokes every credential', async () => {
    await harness.service.reset(rawToken, 'brand-new-password', CTX);

    const user = await harness.repo.findUserByEmail('a@example.com');
    expect(user?.passwordHash).toBe('hashed:brand-new-password');
    // The point of the revocation: whoever forced the reset must not leave an
    // attacker holding a working session.
    expect(harness.revoked).toEqual([{ userId: user?.id as string, reason: 'password_changed' }]);
    expect((await harness.audit.list({})).map((e) => e.action)).toContain(
      'password.reset_completed',
    );
  });

  test('the link works exactly once', async () => {
    await harness.service.reset(rawToken, 'brand-new-password', CTX);
    const err = await harness.service.reset(rawToken, 'another-password', CTX).catch((e) => e);
    expect(isAppError(err) && err.code).toBe('UNAUTHENTICATED');
  });

  test('an expired link is refused', async () => {
    const h = make(Date.UTC(2026, 0, 1));
    await seedUser(h.repo);
    await h.service.request('a@example.com', CTX);
    const token = tokenFromLink(h.mailer.sent[0]?.url as string);

    // Move past the TTL.
    h.repo.now = () => Date.UTC(2026, 0, 1) + (TTL_MINUTES + 1) * 60_000;

    const err = await h.service.reset(token, 'brand-new-password', CTX).catch((e) => e);
    expect(isAppError(err) && err.code).toBe('UNAUTHENTICATED');
    expect(h.revoked).toEqual([]);
  });

  test('unknown, expired and used links all fail with the same message', async () => {
    const unknown = await harness.service
      .reset('0'.repeat(64), 'pw-attempt-1', CTX)
      .catch((e) => e);

    await harness.service.reset(rawToken, 'pw-attempt-2', CTX); // succeeds
    const used = await harness.service.reset(rawToken, 'pw-attempt-3', CTX).catch((e) => e);

    const expired = make(Date.UTC(2026, 0, 1));
    await seedUser(expired.repo);
    await expired.service.request('a@example.com', CTX);
    const staleToken = tokenFromLink(expired.mailer.sent[0]?.url as string);
    expired.repo.now = () => Date.UTC(2026, 0, 1) + (TTL_MINUTES + 1) * 60_000;
    const stale = await expired.service.reset(staleToken, 'pw-attempt-4', CTX).catch((e) => e);

    // One message for all three: the endpoint must not say which link existed.
    for (const err of [unknown, used, stale]) {
      expect(isAppError(err) && err.code).toBe('UNAUTHENTICATED');
      expect(isAppError(err) && err.message).toBe('invalid or expired reset link');
    }
  });

  test('a failed reset changes nothing', async () => {
    await harness.service.reset('0'.repeat(64), 'brand-new-password', CTX).catch(() => {});
    const user = await harness.repo.findUserByEmail('a@example.com');
    expect(user?.passwordHash).toBe('hashed:old-password');
    expect(harness.revoked).toEqual([]);
  });
});

describe('TransportPasswordResetMailer', () => {
  test('sends a transactional mail with the link and no unsubscribe footer', async () => {
    const sent: Array<Record<string, string>> = [];
    const mailer = new TransportPasswordResetMailer({
      from: 'FlyTrace <no-reply@example.com>',
      transport: {
        async send(email) {
          sent.push(email as unknown as Record<string, string>);
          return { ok: true, status: 200 };
        },
      },
    });

    await mailer.sendResetLink({
      email: 'a@example.com',
      url: 'https://app.example.com/reset-password?token=abc',
      expiresInMinutes: 60,
    });

    expect(sent).toHaveLength(1);
    const mail = sent[0] as Record<string, string>;
    expect(mail.to).toBe('a@example.com');
    expect(mail.html).toContain('https://app.example.com/reset-password?token=abc');
    expect(mail.text).toContain('expires in 60 minutes');
    // A password reset must not be unsubscribable.
    expect(mail.html).not.toContain('settings/notifications');
    expect(mail.html).not.toContain('Open flight');
  });

  test('a non-2xx response raises, so the caller can log the outage', async () => {
    const mailer = new TransportPasswordResetMailer({
      from: 'x',
      transport: {
        async send() {
          return { ok: false, status: 500 };
        },
      },
    });
    await expect(
      mailer.sendResetLink({ email: 'a@b.c', url: 'https://x/y', expiresInMinutes: 60 }),
    ).rejects.toThrow('500');
  });
});
