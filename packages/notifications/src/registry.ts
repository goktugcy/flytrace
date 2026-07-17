import type { ChannelKey, NotificationChannel } from './types.ts';

/** Registry of enabled channel adapters (docs/10 §10.1). */
export class ChannelRegistry {
  private readonly channels = new Map<ChannelKey, NotificationChannel>();

  register(channel: NotificationChannel): this {
    this.channels.set(channel.key, channel);
    return this;
  }
  get(key: ChannelKey): NotificationChannel | null {
    return this.channels.get(key) ?? null;
  }
  has(key: ChannelKey): boolean {
    return this.channels.has(key);
  }
  keys(): ChannelKey[] {
    return [...this.channels.keys()];
  }
}
