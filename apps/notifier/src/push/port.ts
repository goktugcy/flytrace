/** Web Push delivery port (docs/10 §10.6). The real adapter uses VAPID; tests
 * and the offline pipeline smoke use an in-memory fake. */
export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushMessage {
  title: string;
  body: string;
  url: string;
}

/** `gone` marks a dead subscription (HTTP 404/410) that should be pruned. */
export type PushResult = { ok: true } | { ok: false; gone: boolean; error: string };

export interface PushSender {
  send(sub: PushSubscription, msg: PushMessage): Promise<PushResult>;
}
