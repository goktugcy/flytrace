import { describe, expect, test } from 'bun:test';
import { parseClientMessage, serverMessageSchema } from './protocol.ts';

describe('parseClientMessage', () => {
  test('parses each client message kind', () => {
    expect(parseClientMessage('{"t":"ping"}')?.t).toBe('ping');
    expect(parseClientMessage('{"t":"subscribe","channel":"flight:x"}')?.t).toBe('subscribe');
    expect(parseClientMessage('{"t":"subscribe","channel":"flight:x","cursor":"1-0"}')).toEqual({
      t: 'subscribe',
      channel: 'flight:x',
      cursor: '1-0',
    });
    expect(parseClientMessage('{"t":"viewport","bbox":[1,2,3,4],"zoom":6}')).toEqual({
      t: 'viewport',
      bbox: [1, 2, 3, 4],
      zoom: 6,
    });
  });

  test('rejects malformed / unknown messages', () => {
    expect(parseClientMessage('not json')).toBeNull();
    expect(parseClientMessage('{"t":"nope"}')).toBeNull();
    expect(parseClientMessage('{"t":"viewport","bbox":[1,2,3]}')).toBeNull(); // bbox needs 4
    expect(parseClientMessage('{"t":"subscribe"}')).toBeNull(); // missing channel
  });
});

describe('serverMessageSchema', () => {
  test('validates a hello message', () => {
    const hello = {
      t: 'hello',
      connectionId: 'c1',
      serverTime: '2026-01-01T00:00:00.000Z',
      heartbeatMs: 15000,
      resumeWindowMs: 120000,
    };
    expect(serverMessageSchema.safeParse(hello).success).toBe(true);
  });
});
