import { describe, expect, it } from 'bun:test';
import {
  assessLogin,
  haversineKm,
  impossibleTravel,
  isNewDevice,
  isNewIpPrefix,
} from './suspicious-login.ts';

const LONDON = { lat: 51.5074, lon: -0.1278 };
const NEW_YORK = { lat: 40.7128, lon: -74.006 };
const HOUR = 3_600_000;

describe('isNewDevice', () => {
  it('is false for a known fingerprint, true otherwise', () => {
    expect(isNewDevice(['a', 'b'], 'a')).toBe(false);
    expect(isNewDevice(['a', 'b'], 'z')).toBe(true);
    expect(isNewDevice([], 'z')).toBe(true);
  });
});

describe('isNewIpPrefix', () => {
  it('is false when ip is within a known /24', () => {
    expect(isNewIpPrefix(['203.0.113.9'], '203.0.113.200')).toBe(false);
  });
  it('is true when ip is in a different /24', () => {
    expect(isNewIpPrefix(['203.0.113.9'], '203.0.114.9')).toBe(true);
  });
  it('handles IPv6 /48 grouping', () => {
    expect(isNewIpPrefix(['2001:db8:abcd:1::1'], '2001:db8:abcd:ffff::9')).toBe(false);
    expect(isNewIpPrefix(['2001:db8:abcd:1::1'], '2001:db8:abce:1::9')).toBe(true);
  });
});

describe('haversineKm', () => {
  it('approximates the London↔New York great-circle distance', () => {
    const d = haversineKm(LONDON, NEW_YORK);
    expect(d).toBeGreaterThan(5500);
    expect(d).toBeLessThan(5600);
  });
  it('is zero for identical points', () => {
    expect(haversineKm(LONDON, LONDON)).toBe(0);
  });
});

describe('impossibleTravel', () => {
  it('flags London→NY in 1h as impossible at 900 km/h', () => {
    expect(impossibleTravel(LONDON, 0, NEW_YORK, HOUR, 900)).toBe(true);
  });
  it('allows London→NY in 8h at 900 km/h', () => {
    expect(impossibleTravel(LONDON, 0, NEW_YORK, 8 * HOUR, 900)).toBe(false);
  });
  it('treats a real move with non-positive elapsed time as impossible', () => {
    expect(impossibleTravel(LONDON, HOUR, NEW_YORK, HOUR, 900)).toBe(true);
    expect(impossibleTravel(LONDON, HOUR, LONDON, HOUR, 900)).toBe(false);
  });
});

describe('assessLogin', () => {
  const base = {
    fingerprint: 'known-fp',
    knownFingerprints: ['known-fp'],
    ip: '203.0.113.9',
    knownIps: ['203.0.113.1'],
  };

  it('is low risk for a known device on a known network', () => {
    expect(assessLogin(base)).toEqual({ risk: 'low', reasons: [] });
  });

  it('is medium for a single signal (new device only)', () => {
    const r = assessLogin({ ...base, fingerprint: 'new-fp' });
    expect(r.risk).toBe('medium');
    expect(r.reasons).toEqual(['new_device']);
  });

  it('is high for new device AND new ip prefix', () => {
    const r = assessLogin({ ...base, fingerprint: 'new-fp', ip: '198.51.100.9' });
    expect(r.risk).toBe('high');
    expect(r.reasons).toContain('new_device');
    expect(r.reasons).toContain('new_ip_prefix');
  });

  it('is high whenever impossible travel is detected', () => {
    const r = assessLogin({
      ...base,
      travel: { prevGeo: LONDON, prevTs: 0, newGeo: NEW_YORK, newTs: HOUR, maxKmh: 900 },
    });
    expect(r.risk).toBe('high');
    expect(r.reasons).toEqual(['impossible_travel']);
  });
});
