import type { EmailMessage, EmailProvider, EmailSendResult } from './index.ts';

export interface BrevoEmailProviderOpts {
  apiKey: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}

interface BrevoResponse {
  messageId?: string;
}

/** Parse `Name <email@host>` into Brevo's structured sender shape. */
function parseSender(from: string): { name?: string; email: string } {
  const match = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (match?.[2]) {
    const name = (match[1] ?? '').trim();
    return name ? { name, email: match[2] } : { email: match[2] };
  }
  return { email: from.trim() };
}

/**
 * Brevo (formerly Sendinblue) HTTP adapter. Uses the transactional email
 * endpoint; `fetch` is injectable so it is testable with no network.
 */
export class BrevoEmailProvider implements EmailProvider {
  readonly name = 'brevo';
  private readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: BrevoEmailProviderOpts) {
    this.apiUrl = opts.apiUrl ?? 'https://api.brevo.com/v3/smtp/email';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async send(msg: EmailMessage): Promise<EmailSendResult> {
    const res = await this.fetchImpl(this.apiUrl, {
      method: 'POST',
      headers: {
        'api-key': this.opts.apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: parseSender(msg.from),
        to: [{ email: msg.to }],
        subject: msg.subject,
        htmlContent: msg.html,
        ...(msg.text ? { textContent: msg.text } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`brevo: send failed (${res.status})`);
    }
    const body = (await res.json()) as BrevoResponse;
    return { id: body.messageId ?? '' };
  }
}
