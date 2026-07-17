import { describe, expect, test } from 'bun:test';
import { authorizeChannel, inBbox, parseChannel } from './channels.ts';
import type { TicketPayload } from './ticket.ts';

const guest: TicketPayload = { uid: null, role: 'guest', iat: 0, exp: 1, jti: 'j', bind: '' };
const user = (uid: string): TicketPayload => ({ ...guest, uid, role: 'user' });
const admin: TicketPayload = { ...guest, uid: 'a', role: 'admin' };

/** Parse a channel, asserting it is valid (test helper). */
function ch(raw: string) {
  const c = parseChannel(raw);
  if (!c) throw new Error(`invalid test channel: ${raw}`);
  return c;
}

describe('parseChannel', () => {
  test('parses known channel kinds', () => {
    expect(parseChannel('flight:abc')).toEqual({
      kind: 'flight',
      flightId: 'abc',
      raw: 'flight:abc',
    });
    expect(parseChannel('airport:ist')).toEqual({
      kind: 'airport',
      iata: 'IST',
      raw: 'airport:ist',
    });
    expect(parseChannel('user:u1')).toEqual({ kind: 'user', userId: 'u1', raw: 'user:u1' });
    expect(parseChannel('admin:metrics')).toEqual({ kind: 'admin', raw: 'admin:metrics' });
  });

  test('rejects unknown or malformed channels', () => {
    expect(parseChannel('nope:x')).toBeNull();
    expect(parseChannel('flight:')).toBeNull();
    expect(parseChannel('admin:secrets')).toBeNull();
  });
});

describe('authorizeChannel', () => {
  test('public channels allowed for guests', () => {
    expect(authorizeChannel(ch('flight:x'), guest)).toBe(true);
    expect(authorizeChannel(ch('airport:ist'), guest)).toBe(true);
  });

  test('user channel requires matching uid', () => {
    expect(authorizeChannel(ch('user:u1'), guest)).toBe(false);
    expect(authorizeChannel(ch('user:u1'), user('u2'))).toBe(false);
    expect(authorizeChannel(ch('user:u1'), user('u1'))).toBe(true);
  });

  test('admin channel requires admin role', () => {
    expect(authorizeChannel(ch('admin:metrics'), user('u1'))).toBe(false);
    expect(authorizeChannel(ch('admin:metrics'), admin)).toBe(true);
  });
});

describe('inBbox', () => {
  test('includes points inside and excludes outside', () => {
    const box = [28, 40, 33, 42] as const; // w,s,e,n
    expect(inBbox(41, 30, box)).toBe(true);
    expect(inBbox(39, 30, box)).toBe(false); // south of box
    expect(inBbox(41, 35, box)).toBe(false); // east of box
  });

  test('handles antimeridian wrap (west > east)', () => {
    const box = [170, -10, -170, 10] as const;
    expect(inBbox(0, 175, box)).toBe(true);
    expect(inBbox(0, -175, box)).toBe(true);
    expect(inBbox(0, 0, box)).toBe(false);
  });
});
