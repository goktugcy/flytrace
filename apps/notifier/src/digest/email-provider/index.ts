/**
 * Email provider port for the digest system (docs/10, docs/17 §17.5).
 *
 * Digest code depends only on {@link EmailProvider}; the concrete adapter is
 * chosen from config at composition time via the shared `selectAdapter`
 * convention. The in-repo `mock` adapter is the always-present fallback, so the
 * notifier boots and the whole digest pipeline runs with zero external services.
 * Real HTTP adapters (resend/brevo) activate only when their credentials exist;
 * `smtp` uses a thin injectable transport so no SMTP library is required.
 */
import { type AdapterFactory, selectAdapter } from '@flytrace/shared';
import { BrevoEmailProvider } from './brevo.ts';
import { MockEmailProvider } from './mock.ts';
import { ResendEmailProvider } from './resend.ts';
import { SmtpEmailProvider, type SmtpTransport } from './smtp.ts';

/** A single outbound email. `text` is optional but strongly recommended. */
export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  html: string;
  text?: string;
}

/** Result of a successful send — the provider's message id. */
export interface EmailSendResult {
  id: string;
}

/** The one interface digest code depends on. */
export interface EmailProvider {
  readonly name: string;
  send(msg: EmailMessage): Promise<EmailSendResult>;
}

export interface EmailProviderLogger {
  warn: (msg: string, meta?: unknown) => void;
  info?: (msg: string, meta?: unknown) => void;
}

export interface CreateEmailProviderDeps {
  /** EMAIL_PROVIDER: mock (default) | resend | brevo | smtp. */
  provider?: string;
  /** Resend API key (EMAIL_API_KEY). */
  apiKey?: string;
  /** Brevo API key (BREVO_API_KEY); falls back to `apiKey` if unset. */
  brevoApiKey?: string;
  /** Resend endpoint override (EMAIL_API_URL). */
  apiUrl?: string;
  /** Injectable fetch for the HTTP adapters (tests pass a fake). */
  fetchImpl?: typeof fetch;
  /** Injectable SMTP transport (nodemailer or a fake); required for `smtp`. */
  smtpTransport?: SmtpTransport;
  logger?: EmailProviderLogger;
  /** Injectable id source for the mock adapter. */
  now?: () => number;
}

/**
 * Resolve the configured {@link EmailProvider}. A requested real adapter that
 * is missing its credentials/transport is downgraded to `mock` with a warning
 * so local dev never fails to boot — the selection itself is delegated to the
 * shared `selectAdapter` so behaviour matches every other infra module.
 */
export function createEmailProvider(deps: CreateEmailProviderDeps = {}): Promise<EmailProvider> {
  const { provider, apiKey, brevoApiKey, apiUrl, fetchImpl, smtpTransport, logger, now } = deps;
  const brevoKey = brevoApiKey ?? apiKey;

  // Downgrade to mock when the requested adapter can't actually send. This keeps
  // the offline default working and surfaces the reason once, at composition.
  let effective = provider;
  if (provider === 'resend' && !apiKey) {
    logger?.warn('email: resend selected but EMAIL_API_KEY missing, using "mock"');
    effective = 'mock';
  } else if (provider === 'brevo' && !brevoKey) {
    logger?.warn('email: brevo selected but BREVO_API_KEY/EMAIL_API_KEY missing, using "mock"');
    effective = 'mock';
  } else if (provider === 'smtp' && !smtpTransport) {
    logger?.warn('email: smtp selected but no SMTP transport injected, using "mock"');
    effective = 'mock';
  }

  const adapters: Record<string, AdapterFactory<EmailProvider>> = {
    mock: () => new MockEmailProvider({ ...(logger ? { logger } : {}), ...(now ? { now } : {}) }),
    resend: () =>
      new ResendEmailProvider({
        apiKey: apiKey ?? '',
        ...(apiUrl ? { apiUrl } : {}),
        ...(fetchImpl ? { fetchImpl } : {}),
      }),
    brevo: () =>
      new BrevoEmailProvider({
        apiKey: brevoKey ?? '',
        ...(fetchImpl ? { fetchImpl } : {}),
      }),
    smtp: () => new SmtpEmailProvider({ transport: smtpTransport as SmtpTransport }),
  };

  return selectAdapter({
    label: 'email',
    kind: effective,
    adapters,
    fallback: 'mock',
    ...(logger ? { logger } : {}),
  });
}

export { MockEmailProvider } from './mock.ts';
export { ResendEmailProvider } from './resend.ts';
export { BrevoEmailProvider } from './brevo.ts';
export { SmtpEmailProvider, type SmtpTransport } from './smtp.ts';
