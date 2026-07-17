import { describe, expect, test } from 'bun:test';
import { type TicketPayload, signTicket, verifyTicket } from './ticket.ts';

const SECRET = 'test-secret-at-least-16-chars-long';

function ticket(over: Partial<TicketPayload> = {}): TicketPayload {
  return { uid: null, role: 'guest', iat: 1000, exp: 61_000, jti: 'jti-1', bind: '', ...over };
}

describe('ws ticket', () => {
  test('signs and verifies a fresh ticket', async () => {
    const token = await signTicket(ticket(), SECRET);
    const verified = await verifyTicket(token, SECRET, 2000);
    expect(verified).not.toBeNull();
    expect(verified?.role).toBe('guest');
    expect(verified?.jti).toBe('jti-1');
  });

  test('rejects an expired ticket', async () => {
    const token = await signTicket(ticket({ exp: 5000 }), SECRET);
    expect(await verifyTicket(token, SECRET, 5000)).toBeNull(); // exp <= now
    expect(await verifyTicket(token, SECRET, 4999)).not.toBeNull();
  });

  test('rejects a tampered payload', async () => {
    const token = await signTicket(ticket({ role: 'user', uid: 'u1' }), SECRET);
    const sig = token.split('.')[1];
    const forged = `${Buffer.from(JSON.stringify(ticket({ role: 'admin', uid: 'u1' }))).toString('base64url')}.${sig}`;
    expect(forged).not.toBe(token);
    expect(await verifyTicket(forged, SECRET, 2000)).toBeNull();
  });

  test('rejects a wrong secret', async () => {
    const token = await signTicket(ticket(), SECRET);
    expect(await verifyTicket(token, 'another-secret-16chars', 2000)).toBeNull();
  });

  test('rejects malformed tokens', async () => {
    expect(await verifyTicket('garbage', SECRET, 2000)).toBeNull();
    expect(await verifyTicket('.', SECRET, 2000)).toBeNull();
    expect(await verifyTicket('', SECRET, 2000)).toBeNull();
  });
});
