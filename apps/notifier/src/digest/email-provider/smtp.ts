import type { EmailMessage, EmailProvider, EmailSendResult } from './index.ts';

/**
 * Thin SMTP transport port. A nodemailer `Transporter` satisfies this shape
 * (`sendMail`) directly, so production wiring can pass one without an adapter,
 * yet tests inject a fake — no SMTP library is pulled into this package.
 */
export interface SmtpTransport {
  sendMail(msg: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text?: string;
  }): Promise<{ messageId: string }>;
}

export interface SmtpEmailProviderOpts {
  transport: SmtpTransport;
}

/** SMTP adapter over an injected {@link SmtpTransport}. */
export class SmtpEmailProvider implements EmailProvider {
  readonly name = 'smtp';

  constructor(private readonly opts: SmtpEmailProviderOpts) {}

  async send(msg: EmailMessage): Promise<EmailSendResult> {
    const res = await this.opts.transport.sendMail({
      from: msg.from,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      ...(msg.text ? { text: msg.text } : {}),
    });
    return { id: res.messageId };
  }
}
