/**
 * One decision point for "can this API actually send an email?".
 *
 * Two user-facing security features depend on it — password-reset links and
 * new-device / token-reuse alerts — and both fail *silently* without a
 * transport: the reset endpoint still answers 200 and the alert path still
 * returns success, while nothing arrives. A user who asked for a reset link
 * waits for mail that was never sent.
 *
 * So outside local development a missing key is a REFUSED BOOT, not a warning,
 * matching how the rate limiter, MFA challenge store and internal-endpoint
 * token behave. A deploy that fails loudly is better than an account-recovery
 * path that is quietly broken.
 *
 * `EMAIL_API_KEY` is the only delivery path the API has: `HttpEmailTransport`
 * is its sole non-test transport. `EMAIL_PROVIDER` / `SMTP_URL` /
 * `BREVO_API_KEY` are read by the notifier's digest subsystem only, and setting
 * them does NOT give the API a way to send.
 */
import { HttpEmailTransport } from '@flytrace/notifications';

export interface EmailDeliveryConfig {
  APP_ENV: string;
  EMAIL_API_KEY?: string | undefined;
  EMAIL_API_URL: string;
}

export interface EmailDeliveryDecision {
  /** Null in local development without a key — callers fall back to a recorder. */
  transport: HttpEmailTransport | null;
  mode: 'http' | 'unavailable-local';
}

export function resolveEmailDelivery(cfg: EmailDeliveryConfig): EmailDeliveryDecision {
  const key = cfg.EMAIL_API_KEY?.trim() || '';
  if (key) {
    return {
      transport: new HttpEmailTransport({ apiKey: key, apiUrl: cfg.EMAIL_API_URL }),
      mode: 'http',
    };
  }

  const isDeployed = cfg.APP_ENV === 'production' || cfg.APP_ENV === 'staging';
  if (isDeployed) {
    throw new Error(
      'EMAIL_API_KEY is required outside local development: without it password-reset links and ' +
        'new-device / token-reuse alerts are accepted but never delivered, so account recovery ' +
        'silently does not work. Set EMAIL_API_KEY (the API sends over HTTP only — EMAIL_PROVIDER, ' +
        'SMTP_URL and BREVO_API_KEY are read by the notifier digest, not by the API).',
    );
  }

  return { transport: null, mode: 'unavailable-local' };
}
