import { describe, expect, test } from 'bun:test';
import { type DigestModel, StringDigestRenderer, buildSubject, renderDigest } from './template.ts';

const model: DigestModel = {
  user: { id: 'u1', email: 'pilot@example.com', name: 'Ada' },
  periodLabel: 'Today',
  webBaseUrl: 'https://app.flytrace.test',
  unsubscribeUrl: 'https://app.flytrace.test/u/unsub?t=abc',
  items: [
    { title: 'TK1 landed', detail: 'Arrived at IST gate A12', url: '/flights/id/tk1' },
    { title: 'BA2 delayed', detail: 'Now +35m', url: 'https://elsewhere/flights/ba2' },
  ],
};

describe('renderDigest', () => {
  test('subject reflects item count and period', () => {
    expect(buildSubject(model)).toBe('FlyTrace — Today: 2 updates');
    expect(buildSubject({ ...model, items: [model.items[0]!] })).toBe('FlyTrace — Today: 1 update');
  });

  test('html includes greeting, every item, and unsubscribe footer', () => {
    const { html } = renderDigest(model);
    expect(html).toContain('Ada');
    expect(html).toContain('TK1 landed');
    expect(html).toContain('BA2 delayed');
    expect(html).toContain(model.unsubscribeUrl!);
  });

  test('relative item urls are made absolute; absolute urls left intact', () => {
    const { html, text } = renderDigest(model);
    expect(html).toContain('https://app.flytrace.test/flights/id/tk1');
    expect(text).toContain('https://app.flytrace.test/flights/id/tk1');
    expect(html).toContain('https://elsewhere/flights/ba2');
  });

  test('html escapes user-controlled content', () => {
    const { html } = renderDigest({
      ...model,
      items: [{ title: '<script>x</script>', detail: 'a & b', url: '/x' }],
    });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('a &amp; b');
  });

  test('text renderer produces one block per item and a plain footer', () => {
    const { text } = renderDigest(model);
    expect(text).toContain('- TK1 landed');
    expect(text).toContain('- BA2 delayed');
    expect(text).toContain('Unsubscribe or change frequency: ');
  });

  test('renderer instance matches the renderDigest seam', () => {
    const viaClass = new StringDigestRenderer().render(model);
    expect(viaClass).toEqual(renderDigest(model));
  });
});
