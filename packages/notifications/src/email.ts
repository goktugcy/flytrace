import type {
  ChannelAddress,
  DeliveryResult,
  NotificationChannel,
  RenderedMessage,
} from './types.ts';

export interface OutboundEmail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** Email transport port (docs/10 §10.6) — Resend/SES/SMTP behind one interface. */
export interface EmailTransport {
  send(email: OutboundEmail): Promise<{ ok: boolean; status: number }>;
}

/** Resend-style HTTP transport (injectable fetch for tests). */
export class HttpEmailTransport implements EmailTransport {
  constructor(
    private readonly opts: { apiKey: string; apiUrl?: string; fetchImpl?: typeof fetch },
  ) {}
  async send(email: OutboundEmail): Promise<{ ok: boolean; status: number }> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const res = await fetchImpl(this.opts.apiUrl ?? 'https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.opts.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(email),
    });
    return { ok: res.ok, status: res.status };
  }
}

interface EmailAddress {
  email: string;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Email channel (docs/10 §10.6): HTML + plaintext, deep-link button, unsubscribe. */
export class EmailChannel implements NotificationChannel {
  readonly key = 'email' as const;

  constructor(
    private readonly opts: { from: string; transport: EmailTransport; webBaseUrl: string },
  ) {}

  async send(address: ChannelAddress, message: RenderedMessage): Promise<DeliveryResult> {
    const { email } = address as unknown as EmailAddress;
    const link = `${this.opts.webBaseUrl}${message.url}`;
    const unsubscribe = `${this.opts.webBaseUrl}/settings/notifications`;
    const html = `<h2>${escapeHtml(message.title)}</h2><p>${escapeHtml(message.body)}</p>
<p><a href="${link}">Open flight</a></p>
<hr><p style="color:#888;font-size:12px">You get these because you're watching this flight. <a href="${unsubscribe}">Manage notifications</a>.</p>`;
    const text = `${message.title}\n\n${message.body}\n\nOpen: ${link}\nManage notifications: ${unsubscribe}`;
    try {
      const { ok, status } = await this.opts.transport.send({
        from: this.opts.from,
        to: email,
        subject: message.title,
        html,
        text,
      });
      if (ok) return { ok: true };
      return { ok: false, gone: status === 422, error: `email ${status}` };
    } catch (err) {
      return { ok: false, gone: false, error: String(err) };
    }
  }
}

/** In-memory transport for tests/offline. */
export class FakeEmailTransport implements EmailTransport {
  readonly sent: OutboundEmail[] = [];
  constructor(private readonly behavior: { status?: number } = {}) {}
  async send(email: OutboundEmail): Promise<{ ok: boolean; status: number }> {
    this.sent.push(email);
    const status = this.behavior.status ?? 200;
    return { ok: status >= 200 && status < 300, status };
  }
}
