/**
 * DigestService (docs/10, docs/17 §17.5) — turns a per-user digest model into a
 * sent email. It is entirely dependency-injected: the email provider, the model
 * builder (which reads whatever data source), and the renderer are all supplied,
 * so the service is pure orchestration and trivially testable.
 */
import type { EmailProvider } from './email-provider/index.ts';
import { type DigestModel, type RenderedDigest, renderDigest } from './template.ts';

export type SendDigestOutcome = 'sent' | 'skipped';

export interface DigestServiceLogger {
  info?: (msg: string, meta?: unknown) => void;
  warn?: (msg: string, meta?: unknown) => void;
  error?: (msg: string, meta?: unknown) => void;
}

export interface DigestServiceDeps {
  emailProvider: EmailProvider;
  /** Build the digest model for a user, or null/empty when there is nothing. */
  buildDigestFor: (userId: string) => Promise<DigestModel | null> | DigestModel | null;
  /** From address for outbound digests. */
  from: string;
  /** Optional renderer override (defaults to the string renderer). */
  render?: (model: DigestModel) => RenderedDigest;
  logger?: DigestServiceLogger;
}

export class DigestService {
  private readonly render: (model: DigestModel) => RenderedDigest;

  constructor(private readonly deps: DigestServiceDeps) {
    this.render = deps.render ?? renderDigest;
  }

  /**
   * Build and send one user's digest. Skips (no send) when the user has no
   * model or an empty item list. Returns the outcome; throws only if the
   * provider send itself fails (so the caller's retry logic can react).
   */
  async sendDigest(userId: string): Promise<SendDigestOutcome> {
    const model = await this.deps.buildDigestFor(userId);
    if (!model || model.items.length === 0) {
      this.deps.logger?.info?.('digest: skipped (no items)', { userId });
      return 'skipped';
    }

    const rendered = this.render(model);
    const { id } = await this.deps.emailProvider.send({
      to: model.user.email,
      from: this.deps.from,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    this.deps.logger?.info?.('digest: sent', {
      userId,
      to: model.user.email,
      items: model.items.length,
      id,
    });
    return 'sent';
  }
}
