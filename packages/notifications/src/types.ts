/**
 * Channel abstraction (docs/10 §10.1): the core never branches on channel type
 * beyond a registry lookup. Adding SMS/Slack later = a new adapter + enum value.
 */
export type ChannelKey = 'webpush' | 'telegram' | 'email';

/** Channel-agnostic message; each adapter renders it to its own format. */
export interface RenderedMessage {
  title: string;
  body: string;
  /** App-relative deep link (e.g. /flights/id/<id>). */
  url: string;
}

/** A user's endpoint for a channel (shape is channel-specific). */
export type ChannelAddress = Record<string, unknown>;

/** `gone` marks a dead endpoint (webpush 404/410, telegram 403) → prune it. */
export type DeliveryResult = { ok: true } | { ok: false; gone: boolean; error: string };

export interface NotificationChannel {
  readonly key: ChannelKey;
  send(address: ChannelAddress, message: RenderedMessage): Promise<DeliveryResult>;
}
