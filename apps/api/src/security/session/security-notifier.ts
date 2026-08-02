/**
 * Out-of-band security notifications (docs §7b).
 *
 * When something security-relevant happens to an account — a sign-in from a
 * device we have never seen, a refresh-token replay, a credential change — the
 * user should hear about it on a channel the attacker does not control. This
 * reuses the existing notification plumbing (`@flytrace/notifications` +
 * `notification_channels`) rather than inventing a second delivery path.
 *
 * Delivery is BEST EFFORT by design: a mail outage must never fail a sign-in or
 * a token rotation. Every failure is logged and swallowed. Message bodies carry
 * no tokens, no session ids and no exact IP — only the coarse signals the user
 * needs to recognise "that was not me".
 */
import type { ChannelEndpoint, ChannelKey } from '@flytrace/db';
import type { NotificationChannel, RenderedMessage } from '@flytrace/notifications';
import type { Logger } from '@flytrace/shared';

export type SecurityEventKind =
  | 'new_device'
  | 'refresh_token_reuse'
  | 'password_changed'
  | 'mfa_disabled'
  | 'mfa_enabled';

export interface SecurityNotification {
  userId: string;
  kind: SecurityEventKind;
  title: string;
  body: string;
  /** App-relative deep link, e.g. /settings/notifications. */
  url?: string;
}

export interface SecurityNotifier {
  notify(notification: SecurityNotification): Promise<void>;
}

/** Used when no delivery channel is configured (local dev, tests). */
export class NoopSecurityNotifier implements SecurityNotifier {
  readonly sent: SecurityNotification[] = [];
  async notify(notification: SecurityNotification): Promise<void> {
    this.sent.push(notification);
  }
}

/** The slice of the notify repo this needs — keeps the module easy to fake. */
export interface SecurityNotifierRepo {
  channelEndpoints(userId: string, channel: ChannelKey): Promise<ChannelEndpoint[]>;
}

export interface ChannelSecurityNotifierDeps {
  repo: SecurityNotifierRepo;
  /** Adapters to try, in order. Usually just the email channel. */
  channels: Array<{ key: ChannelKey; adapter: NotificationChannel }>;
  logger: Logger;
}

/**
 * Fans a security notification out to the user's verified endpoints on each
 * configured channel.
 */
export class ChannelSecurityNotifier implements SecurityNotifier {
  constructor(private readonly deps: ChannelSecurityNotifierDeps) {}

  async notify(notification: SecurityNotification): Promise<void> {
    const message: RenderedMessage = {
      title: notification.title,
      body: notification.body,
      url: notification.url ?? '/settings/notifications',
    };

    for (const { key, adapter } of this.deps.channels) {
      try {
        const endpoints = await this.deps.repo.channelEndpoints(notification.userId, key);
        for (const endpoint of endpoints) {
          const result = await adapter.send(endpoint.address, message);
          if (!result.ok) {
            // Log the failure WITHOUT the address — it is user PII and the
            // channel id is enough to correlate.
            this.deps.logger.warn('security notification delivery failed', {
              kind: notification.kind,
              channel: key,
              channelId: endpoint.channelId,
              error: result.error,
            });
          }
        }
      } catch (err) {
        this.deps.logger.warn('security notification channel errored', {
          kind: notification.kind,
          channel: key,
          err: String(err),
        });
      }
    }
  }
}
