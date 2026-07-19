/**
 * Thin zod-to-Hono validation helpers. Each returns a function that validates
 * one part of the request (query string or JSON body) and either yields the
 * parsed, typed value or throws the app's `AppError('BAD_REQUEST', …)` — so
 * route handlers get a single, consistent failure path via the app's onError.
 */
import { AppError } from '@flytrace/shared';
import type { Context } from 'hono';
import type { z } from 'zod';

/**
 * Validate `c.req.query()` against `schema`. Returns a synchronous extractor.
 *
 * ```ts
 * const parseQuery = validateQuery(bboxSchema);
 * const { bbox } = parseQuery(c);
 * ```
 */
export function validateQuery<S extends z.ZodTypeAny>(schema: S): (c: Context) => z.infer<S> {
  return (c: Context): z.infer<S> => {
    const parsed = schema.safeParse(c.req.query());
    if (!parsed.success) {
      throw new AppError('BAD_REQUEST', 'invalid query parameters', {
        details: parsed.error.issues,
      });
    }
    return parsed.data;
  };
}

/**
 * Validate the JSON body against `schema`. Returns an async extractor that also
 * treats malformed/absent JSON as a BAD_REQUEST (never a 500).
 */
export function validateJson<S extends z.ZodTypeAny>(
  schema: S,
): (c: Context) => Promise<z.infer<S>> {
  return async (c: Context): Promise<z.infer<S>> => {
    const body = await c.req.json().catch(() => undefined);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new AppError('BAD_REQUEST', 'invalid request body', {
        details: parsed.error.issues,
      });
    }
    return parsed.data;
  };
}
