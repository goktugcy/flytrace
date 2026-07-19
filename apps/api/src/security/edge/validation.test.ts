import { describe, expect, it } from 'bun:test';
import { type AppError, isAppError } from '@flytrace/shared';
import type { Context } from 'hono';
import { z } from 'zod';
import { validateJson, validateQuery } from './validation.ts';

function queryContext(query: Record<string, string>): Context {
  return { req: { query: () => query } } as unknown as Context;
}

function jsonContext(body: unknown, throwOnParse = false): Context {
  return {
    req: {
      json: async () => {
        if (throwOnParse) throw new Error('bad json');
        return body;
      },
    },
  } as unknown as Context;
}

describe('validateQuery', () => {
  const parse = validateQuery(z.object({ page: z.coerce.number().int().positive() }));

  it('returns typed, coerced data on success', () => {
    expect(parse(queryContext({ page: '3' }))).toEqual({ page: 3 });
  });

  it('throws AppError BAD_REQUEST on failure', () => {
    let caught: unknown;
    try {
      parse(queryContext({ page: 'nope' }));
    } catch (e) {
      caught = e;
    }
    expect(isAppError(caught)).toBe(true);
    expect((caught as AppError).code).toBe('BAD_REQUEST');
    expect((caught as AppError).httpStatus).toBe(400);
  });
});

describe('validateJson', () => {
  const parse = validateJson(z.object({ email: z.string().email() }));

  it('returns parsed data on success', async () => {
    expect(await parse(jsonContext({ email: 'a@b.co' }))).toEqual({ email: 'a@b.co' });
  });

  it('throws BAD_REQUEST on schema mismatch', async () => {
    let caught: unknown;
    await parse(jsonContext({ email: 'not-an-email' })).catch((e) => {
      caught = e;
    });
    expect((caught as AppError).code).toBe('BAD_REQUEST');
  });

  it('throws BAD_REQUEST on malformed JSON (never 500)', async () => {
    let caught: unknown;
    await parse(jsonContext(undefined, true)).catch((e) => {
      caught = e;
    });
    expect(isAppError(caught)).toBe(true);
    expect((caught as AppError).code).toBe('BAD_REQUEST');
  });
});
