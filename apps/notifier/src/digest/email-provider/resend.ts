import type { EmailMessage, EmailProvider, EmailSendResult } from './index.ts';

export interface ResendEmailProviderOpts {
  apiKey: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}

interface ResendResponse {
  id?: string;
}

/**
 * Resend HTTP adapter (https://resend.com). Calls the API only when constructed
 * with a key; `fetch` is injectable so it is testable with no network.
 */
export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend';
  private readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ResendEmailProviderOpts) {
    this.apiUrl = opts.apiUrl ?? 'https://api.resend.com/emails';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async send(msg: EmailMessage): Promise<EmailSendResult> {
    const res = await this.fetchImpl(this.apiUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.opts.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: msg.from,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        ...(msg.text ? { text: msg.text } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`resend: send failed (${res.status})`);
    }
    const body = (await res.json()) as ResendResponse;
    return { id: body.id ?? '' };
  }
}
