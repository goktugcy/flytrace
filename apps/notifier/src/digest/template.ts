/**
 * Digest email template engine (docs/10, docs/17 §17.5).
 *
 * A dependency-free template-string renderer that builds both HTML and plain
 * text from a typed model. The renderer sits behind the {@link DigestRenderer}
 * interface and the {@link renderDigest} function so a richer engine (e.g. React
 * Email) can replace it later without touching the digest service.
 */

/** One line item in a digest (a flight event, an alert, etc.). */
export interface DigestItem {
  title: string;
  detail: string;
  url: string;
}

export interface DigestUser {
  id: string;
  email: string;
  name?: string;
}

/** The fully-resolved model a renderer turns into an email. */
export interface DigestModel {
  user: DigestUser;
  /** Human label for the period, e.g. "Today" or "This week". */
  periodLabel: string;
  items: DigestItem[];
  /** Absolute unsubscribe/manage link (footer). */
  unsubscribeUrl?: string;
  /** Absolute base URL for making relative item links absolute. */
  webBaseUrl?: string;
}

export interface RenderedDigest {
  subject: string;
  html: string;
  text: string;
}

/** The seam a React-Email (or any) renderer implements to replace the default. */
export interface DigestRenderer {
  render(model: DigestModel): RenderedDigest;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Resolve a possibly-relative item URL against the model's base URL. */
function absoluteUrl(url: string, base?: string): string {
  if (!base) return url;
  if (/^https?:\/\//i.test(url)) return url;
  return `${base.replace(/\/$/, '')}/${url.replace(/^\//, '')}`;
}

export function buildSubject(model: DigestModel): string {
  const n = model.items.length;
  const noun = n === 1 ? 'update' : 'updates';
  return `FlyTrace — ${model.periodLabel}: ${n} ${noun}`;
}

function renderHtml(model: DigestModel): string {
  const greetingName = model.user.name ? escapeHtml(model.user.name) : 'there';
  const rows = model.items
    .map((item) => {
      const href = escapeHtml(absoluteUrl(item.url, model.webBaseUrl));
      return `<tr><td style="padding:12px 0;border-bottom:1px solid #eee">
<a href="${href}" style="color:#0b63c4;text-decoration:none;font-weight:600;font-size:15px">${escapeHtml(
        item.title,
      )}</a>
<div style="color:#555;font-size:13px;margin-top:4px">${escapeHtml(item.detail)}</div>
</td></tr>`;
    })
    .join('\n');

  const footer = model.unsubscribeUrl
    ? `<p style="color:#888;font-size:12px;margin-top:24px">You receive FlyTrace digests based on your notification preferences. <a href="${escapeHtml(
        model.unsubscribeUrl,
      )}" style="color:#888">Unsubscribe or change frequency</a>.</p>`
    : '';

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px">
<h1 style="font-size:20px;margin:0 0 4px">FlyTrace digest</h1>
<p style="color:#666;font-size:14px;margin:0 0 20px">${escapeHtml(
    model.periodLabel,
  )} — hi ${greetingName}, here's what happened.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
${footer}
</div>`;
}

function renderText(model: DigestModel): string {
  const header = `FlyTrace digest — ${model.periodLabel}\nHi ${
    model.user.name ?? 'there'
  }, here's what happened.\n`;
  const lines = model.items
    .map(
      (item) => `- ${item.title}\n  ${item.detail}\n  ${absoluteUrl(item.url, model.webBaseUrl)}`,
    )
    .join('\n\n');
  const footer = model.unsubscribeUrl
    ? `\n\nUnsubscribe or change frequency: ${model.unsubscribeUrl}`
    : '';
  return `${header}\n${lines}${footer}\n`;
}

/**
 * Default plain-string renderer. Stateless, so a single instance is reusable.
 */
export class StringDigestRenderer implements DigestRenderer {
  render(model: DigestModel): RenderedDigest {
    return {
      subject: buildSubject(model),
      html: renderHtml(model),
      text: renderText(model),
    };
  }
}

const defaultRenderer = new StringDigestRenderer();

/**
 * Render a digest model to subject/html/text. This function is the stable seam:
 * swap the body for a React-Email renderer later without changing callers.
 */
export function renderDigest(model: DigestModel): RenderedDigest {
  return defaultRenderer.render(model);
}
