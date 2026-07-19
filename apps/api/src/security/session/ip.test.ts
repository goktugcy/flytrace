import { describe, expect, it } from 'bun:test';
import { extractClientIp, ipPrefix, normalizeIp } from './ip.ts';

describe('normalizeIp', () => {
  it('trims, lowercases and strips brackets/zone', () => {
    expect(normalizeIp('  203.0.113.5 ')).toBe('203.0.113.5');
    expect(normalizeIp('[2001:DB8::1]')).toBe('2001:db8::1');
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
  });

  it('unwraps IPv4-mapped IPv6', () => {
    expect(normalizeIp('::ffff:192.168.1.10')).toBe('192.168.1.10');
  });
});

describe('ipPrefix', () => {
  it('computes /24 for IPv4 by default', () => {
    expect(ipPrefix('203.0.113.42')).toBe('203.0.113.0/24');
    expect(ipPrefix('10.1.2.3')).toBe('10.1.2.0/24');
  });

  it('honors custom v4 bit widths (masking mid-octet)', () => {
    expect(ipPrefix('203.0.113.200', 16)).toBe('203.0.0.0/16');
    expect(ipPrefix('192.168.130.9', 25)).toBe('192.168.130.0/25');
    expect(ipPrefix('192.168.130.200', 25)).toBe('192.168.130.128/25');
  });

  it('two IPs in the same /24 share a prefix; different /24 do not', () => {
    expect(ipPrefix('203.0.113.9')).toBe(ipPrefix('203.0.113.250'));
    expect(ipPrefix('203.0.113.9')).not.toBe(ipPrefix('203.0.114.9'));
  });

  it('computes /48 for IPv6 by default (zeroed tail, deterministic form)', () => {
    expect(ipPrefix('2001:db8:abcd:1234::1')).toBe('2001:db8:abcd:0:0:0:0:0/48');
    expect(ipPrefix('2001:db8:abcd:9999::ff', 48)).toBe('2001:db8:abcd:0:0:0:0:0/48');
  });

  it('IPv6 in the same /48 share a prefix', () => {
    expect(ipPrefix('2001:db8:abcd:1::1')).toBe(ipPrefix('2001:db8:abcd:ffff::9'));
    expect(ipPrefix('2001:db8:abcd:1::1')).not.toBe(ipPrefix('2001:db8:abce:1::1'));
  });
});

describe('extractClientIp', () => {
  it('prefers the left-most x-forwarded-for entry', () => {
    expect(extractClientIp({ 'x-forwarded-for': '203.0.113.5, 70.41.3.18, 150.172.238.178' })).toBe(
      '203.0.113.5',
    );
  });

  it('falls back to x-real-ip', () => {
    expect(extractClientIp({ 'x-real-ip': '198.51.100.7' })).toBe('198.51.100.7');
  });

  it('supports a Headers-like source', () => {
    const h = new Headers({ 'x-forwarded-for': '198.51.100.9' });
    expect(extractClientIp(h)).toBe('198.51.100.9');
  });

  it('returns null when no client ip header is present', () => {
    expect(extractClientIp({})).toBeNull();
  });
});
