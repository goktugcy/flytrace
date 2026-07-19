/**
 * Small in-memory retry queue for digest jobs (docs/10, docs/17 §17.5),
 * mirroring the EventBus port/adapter split: business code depends on
 * {@link DigestQueue}; {@link InMemoryDigestQueue} is the offline/test adapter
 * that records processed and dead-lettered jobs for assertions. A durable
 * adapter (Redis stream) can implement the same interface later.
 */

export interface DigestJob {
  userId: string;
  /** Completed attempts so far (0 on first enqueue). */
  attempts: number;
}

export type DigestJobHandler = (job: DigestJob) => Promise<void>;

export interface DigestQueue {
  /** Add a user to the queue (attempts start at 0). */
  enqueue(userId: string): Promise<void>;
  /** Pending job count. */
  size(): number;
  /** Process every pending job to completion (with retry), then resolve. */
  drain(): Promise<void>;
}

export interface InMemoryDigestQueueOpts {
  handler: DigestJobHandler;
  /** Total attempts per job before dead-lettering (default 3). */
  maxAttempts?: number;
  /** Backoff before attempt N (1-based). Default: 100ms * 2^(N-1). */
  backoffMs?: (attempt: number) => number;
  /** Injectable sleep so tests advance without real timers. */
  sleep?: (ms: number) => Promise<void>;
  logger?: {
    warn?: (msg: string, meta?: unknown) => void;
    error?: (msg: string, meta?: unknown) => void;
  };
}

const defaultBackoff = (attempt: number): number => 100 * 2 ** (attempt - 1);
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class InMemoryDigestQueue implements DigestQueue {
  /** Jobs whose handler ultimately succeeded (for assertions). */
  readonly processed: DigestJob[] = [];
  /** Jobs that exhausted all attempts. */
  readonly deadLettered: { job: DigestJob; error: string }[] = [];

  private readonly pending: DigestJob[] = [];
  private readonly handler: DigestJobHandler;
  private readonly maxAttempts: number;
  private readonly backoffMs: (attempt: number) => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: InMemoryDigestQueueOpts['logger'];

  constructor(opts: InMemoryDigestQueueOpts) {
    this.handler = opts.handler;
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
    this.backoffMs = opts.backoffMs ?? defaultBackoff;
    this.sleep = opts.sleep ?? defaultSleep;
    this.logger = opts.logger;
  }

  async enqueue(userId: string): Promise<void> {
    this.pending.push({ userId, attempts: 0 });
  }

  size(): number {
    return this.pending.length;
  }

  async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const job = this.pending.shift() as DigestJob;
      await this.process(job);
    }
  }

  private async process(job: DigestJob): Promise<void> {
    let lastError = '';
    for (let attempt = job.attempts + 1; attempt <= this.maxAttempts; attempt += 1) {
      if (attempt > 1) await this.sleep(this.backoffMs(attempt));
      try {
        await this.handler({ userId: job.userId, attempts: attempt });
        this.processed.push({ userId: job.userId, attempts: attempt });
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.logger?.warn?.('digest-queue: attempt failed', {
          userId: job.userId,
          attempt,
          error: lastError,
        });
      }
    }
    this.deadLettered.push({ job: { ...job, attempts: this.maxAttempts }, error: lastError });
    this.logger?.error?.('digest-queue: dead-lettered', { userId: job.userId, error: lastError });
  }
}
