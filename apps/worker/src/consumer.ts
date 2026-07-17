import { type Logger, baseEnvelopeSchema, streamKeys } from '@flytrace/shared';
import type { EventEnvelope } from '@flytrace/shared';
import type { Redis } from 'ioredis';
import type { Persister } from './persist.ts';

export interface ConsumerOptions {
  group: string;
  consumer: string;
  batchSize: number;
  blockMs: number;
}

/**
 * Durable at-least-once consumer of the domain-event stream (docs/09 §9.5).
 * Uses a Redis consumer group so events survive restarts and are load-balanced
 * across worker replicas; each batch is persisted then XACKed. Delivery is
 * at-least-once — safe because {@link Persister} writes are idempotent.
 */
export class StreamConsumer {
  private running = false;

  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly persister: Persister,
    private readonly logger: Logger,
    private readonly options: ConsumerOptions,
  ) {}

  private get streamKey(): string {
    return `${this.prefix}${streamKeys.events}`;
  }

  /** Create the group at the stream's start (0) so the backlog is consumed. */
  async ensureGroup(): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', this.streamKey, this.options.group, '0', 'MKSTREAM');
    } catch (err) {
      if (!String(err).includes('BUSYGROUP')) throw err;
    }
  }

  /** Read + persist + ack one batch. Returns how many entries were processed. */
  async runOnce(): Promise<number> {
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

    if (!res || res.length === 0) return 0;
    const entries = res[0]?.[1] ?? [];
    if (entries.length === 0) return 0;

    const ackIds: string[] = [];
    for (const [id, fields] of entries) {
      const env = this.decode(fields);
      if (env) {
        try {
          await this.persister.handle(env);
        } catch (err) {
          this.logger.error('persist failed', { id, err: String(err) });
          continue; // leave un-acked → redelivered later (PEL)
        }
      }
      ackIds.push(id); // ack malformed (poison) too, so it doesn't loop forever
    }

    await this.persister.flush();
    if (ackIds.length > 0) {
      await this.redis.xack(this.streamKey, this.options.group, ...ackIds);
    }
    return ackIds.length;
  }

  async start(): Promise<void> {
    this.running = true;
    await this.ensureGroup();
    this.logger.info('worker consuming', { stream: this.streamKey, group: this.options.group });
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

  private decode(fields: string[]): EventEnvelope | null {
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
