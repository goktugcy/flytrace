/**
 * Shared dataset loading for the real airspace providers. A dataset location is
 * either an `http(s)://` URL (fetched) or a local filesystem path (read). All
 * failures degrade to `null` so a mis-configured dataset never crashes the
 * tracker — it just behaves like an empty dataset.
 */
import { readFile } from 'node:fs/promises';
import type { Logger } from '@flytrace/shared';

/**
 * Read a dataset's raw text from a URL or filesystem path. Returns `null` when
 * `location` is empty/undefined (adapter is un-configured → no-op) or on any
 * read/fetch error (logged at warn).
 */
export async function readDatasetText(
  location: string | undefined,
  label: string,
  logger?: Logger,
  opts: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<string | null> {
  const loc = location?.trim();
  if (!loc) return null;
  try {
    if (/^https?:\/\//i.test(loc)) {
      const res = await fetch(loc, {
        headers: opts.headers,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
      if (!res.ok) {
        logger?.warn(`airspace(${label}): dataset fetch failed`, { status: res.status, loc });
        return null;
      }
      return await res.text();
    }
    return await readFile(loc, 'utf8');
  } catch (err) {
    logger?.warn(`airspace(${label}): dataset read failed`, { err: String(err), loc });
    return null;
  }
}

/** Parse text as JSON, returning `null` (logged) on syntax errors. */
export function parseJson<T = unknown>(
  text: string | null,
  label: string,
  logger?: Logger,
): T | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    logger?.warn(`airspace(${label}): dataset JSON parse failed`, { err: String(err) });
    return null;
  }
}
