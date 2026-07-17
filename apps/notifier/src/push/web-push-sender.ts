import webpush from 'web-push';
import type { PushMessage, PushResult, PushSender, PushSubscription } from './port.ts';

/** VAPID Web Push adapter (docs/10 §10.6). Encrypts + POSTs to the push service. */
export class WebPushSender implements PushSender {
  constructor(opts: { publicKey: string; privateKey: string; subject: string }) {
    webpush.setVapidDetails(opts.subject, opts.publicKey, opts.privateKey);
  }

  async send(sub: PushSubscription, msg: PushMessage): Promise<PushResult> {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        JSON.stringify(msg),
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
