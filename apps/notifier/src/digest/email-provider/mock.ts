import type { EmailMessage, EmailProvider, EmailProviderLogger, EmailSendResult } from './index.ts';

export interface MockEmailProviderOpts {
  logger?: EmailProviderLogger;
  /** Injectable clock for deterministic ids. */
  now?: () => number;
}

/**
 * In-memory email provider — the DEFAULT (selectAdapter fallback). Records every
 * sent message for assertions and logs at info level, never touching the network.
 */
export class MockEmailProvider implements EmailProvider {
  readonly name = 'mock';
  readonly sent: EmailMessage[] = [];
  private seq = 0;
  private readonly logger?: EmailProviderLogger;
  private readonly now: () => number;

  constructor(opts: MockEmailProviderOpts = {}) {
    if (opts.logger) this.logger = opts.logger;
    this.now = opts.now ?? Date.now;
  }

  async send(msg: EmailMessage): Promise<EmailSendResult> {
    this.sent.push(msg);
    this.seq += 1;
    const id = `mock-${this.now()}-${this.seq}`;
    this.logger?.info?.('email(mock): send', { to: msg.to, subject: msg.subject, id });
    return { id };
  }

  /** Test helper: clear the recorded outbox. */
  clear(): void {
    this.sent.length = 0;
  }
}
