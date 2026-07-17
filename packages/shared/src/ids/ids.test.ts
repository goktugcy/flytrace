import { describe, expect, test } from 'bun:test';
import { correlationId, uuidv7 } from './index.ts';

describe('uuidv7', () => {
  test('has valid v7 shape', () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('is time-ordered', () => {
    const a = uuidv7(1_000);
    const b = uuidv7(2_000);
    expect(a < b).toBe(true);
  });

  test('is unique across calls', () => {
    const set = new Set(Array.from({ length: 1000 }, () => uuidv7()));
    expect(set.size).toBe(1000);
  });
});

describe('correlationId', () => {
  test('returns 24 hex chars', () => {
    expect(correlationId()).toMatch(/^[0-9a-f]{24}$/);
  });
});
