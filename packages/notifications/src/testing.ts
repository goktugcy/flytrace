import type {
  ChannelAddress,
  ChannelKey,
  DeliveryResult,
  NotificationChannel,
  RenderedMessage,
} from './types.ts';

/** In-memory channel for tests/offline: records every send. */
export class FakeChannel implements NotificationChannel {
  readonly sent: { address: ChannelAddress; message: RenderedMessage }[] = [];

  constructor(
    readonly key: ChannelKey,
    private readonly behavior: { gone?: boolean; fail?: boolean } = {},
  ) {}

  async send(address: ChannelAddress, message: RenderedMessage): Promise<DeliveryResult> {
    this.sent.push({ address, message });
    if (this.behavior.gone) return { ok: false, gone: true, error: 'gone' };
    if (this.behavior.fail) return { ok: false, gone: false, error: 'boom' };
    return { ok: true };
  }
}
