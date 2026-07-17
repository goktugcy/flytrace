import webpush from 'web-push';
import type {
  ChannelAddress,
  DeliveryResult,
  NotificationChannel,
  RenderedMessage,
} from './types.ts';

interface WebPushAddress {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** VAPID Web Push channel (docs/10 §10.6). Payload is the JSON the SW renders. */
export class WebPushChannel implements NotificationChannel {
  readonly key = 'webpush' as const;

  constructor(opts: { publicKey: string; privateKey: string; subject: string }) {
    webpush.setVapidDetails(opts.subject, opts.publicKey, opts.privateKey);
  }

  async send(address: ChannelAddress, message: RenderedMessage): Promise<DeliveryResult> {
    const a = address as unknown as WebPushAddress;
    try {
      await webpush.sendNotification(
        { endpoint: a.endpoint, keys: a.keys },
        JSON.stringify(message),
      );
      return { ok: true };
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      return {
        ok: false,
        gone: status === 404 || status === 410,
        error: String((err as { body?: unknown }).body ?? err),
      };
    }
  }
}
