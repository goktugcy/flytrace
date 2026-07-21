import { type Logger, baseEnvelopeSchema, streamKeys } from '@flytrace/shared';
import type { EventEnvelope } from '@flytrace/shared';
import type { Redis } from 'ioredis';
import type { Notifier } from './notifier.ts';

export interface ConsumerOptions {
  group: string;
  consumer: string;
  batchSize: number;
  blockMs: number;
  pendingClaimIdleMs: number;
}

type StreamEntry = [id: string, fields: string[]];

/**
 * Durable at-least-once consumer of the domain-event stream for the notifier
 * (docs/09 §9.5). Its own consumer group means notifications are independent of
 * the worker's persistence group. Exactly-once delivery is guaranteed downstream
 * by the notifications dedupe key, so at-least-once redelivery here is safe.
 */
export class StreamConsumer {
  private running = false;

  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly notifier: Notifier,
    private readonly logger: Logger,
    private readonly options: ConsumerOptions,
  ) {}

  private get streamKey(): string {
    return `${this.prefix}${streamKeys.events}`;
  }

  async ensureGroup(): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', this.streamKey, this.options.group, '0', 'MKSTREAM');
    } catch (err) {
      if (!String(err).includes('BUSYGROUP')) throw err;
    }
  }

  async runOnce(): Promise<number> {
    const recovered = await this.recoverPending();
    if (recovered > 0) return recovered;

    const res = (await this.redis.xreadgroup(
      'GROUP',
      this.options.group,
      this.options.consumer,
      'COUNT',
      this.options.batchSize,
      'BLOCK',
      this.options.blockMs,
      'STREAMS',
      this.streamKey,
      '>',
    )) as [string, [string, string[]][]][] | null;

    const entries = res?.[0]?.[1] ?? [];
    return this.processEntries(entries);
  }

  /** Reclaim deliveries abandoned by a crashed/restarted consumer. XAUTOCLAIM
   * also clears PEL entries whose stream rows were removed by MAXLEN trimming. */
  async recoverPending(): Promise<number> {
    const result = (await this.redis.xautoclaim(
      this.streamKey,
      this.options.group,
      this.options.consumer,
      this.options.pendingClaimIdleMs,
      '0-0',
      'COUNT',
      this.options.batchSize,
    )) as [nextId: string, entries: StreamEntry[], deletedIds?: string[]];
    return this.processEntries(result[1] ?? []);
  }

  private async processEntries(entries: StreamEntry[]): Promise<number> {
    if (entries.length === 0) return 0;

    const ackIds: string[] = [];
    for (const [id, fields] of entries) {
      const env = decode(fields);
      if (env) {
        try {
          await this.notifier.handle(env);
        } catch (err) {
          this.logger.error('notify failed', { id, err: String(err) });
          continue; // leave un-acked for redelivery
        }
      }
      ackIds.push(id);
    }
    if (ackIds.length > 0) await this.redis.xack(this.streamKey, this.options.group, ...ackIds);
    return ackIds.length;
  }

  async start(): Promise<void> {
    this.running = true;
    await this.ensureGroup();
    this.logger.info('notifier consuming', { stream: this.streamKey, group: this.options.group });
    while (this.running) {
      try {
        await this.runOnce();
      } catch (err) {
        this.logger.error('consumer loop error', { err: String(err) });
        await sleep(1000);
      }
    }
  }

  stop(): void {
    this.running = false;
  }
}

function decode(fields: string[]): EventEnvelope | null {
  let body: string | null = null;
  for (let i = 0; i < fields.length - 1; i += 2)
    if (fields[i] === 'e') body = fields[i + 1] ?? null;
  if (!body) return null;
  try {
    const parsed = baseEnvelopeSchema.safeParse(JSON.parse(body));
    return parsed.success ? (parsed.data as EventEnvelope) : null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
