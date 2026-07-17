import type { PushMessage, PushResult, PushSender, PushSubscription } from './port.ts';

/** In-memory {@link PushSender} for tests and the offline pipeline smoke. */
export class FakePushSender implements PushSender {
  readonly sent: { sub: PushSubscription; msg: PushMessage }[] = [];

  constructor(private readonly behavior: { gone?: boolean; fail?: boolean } = {}) {}

  async send(sub: PushSubscription, msg: PushMessage): Promise<PushResult> {
    this.sent.push({ sub, msg });
    if (this.behavior.gone) return { ok: false, gone: true, error: 'gone' };
    if (this.behavior.fail) return { ok: false, gone: false, error: 'boom' };
    return { ok: true };
  }
}
