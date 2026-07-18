/**
 * Provider-kit — the one env-switchable-adapter convention every infra module
 * uses (secrets, email, airspace, timeseries, pub/sub, …). Business code depends
 * on an interface; a named adapter is chosen from config at composition time,
 * and an always-present in-repo `fallback` (usually a mock/memory adapter) keeps
 * every module runnable locally with zero external services.
 *
 * This mirrors the existing `EventBus`/`InMemoryEventBus` split, generalised so
 * new modules don't reinvent selection + fallback + logging each time.
 */
export type AdapterFactory<T> = () => T | Promise<T>;

export interface SelectAdapterOptions<T> {
  /** Human label for logs/errors, e.g. "email" or "airspace". */
  label: string;
  /** Env-selected adapter name (config value). */
  kind: string | undefined;
  /** Available adapters by name. */
  adapters: Record<string, AdapterFactory<T>>;
  /** Adapter used when `kind` is missing/unknown — must exist in `adapters`. */
  fallback: string;
  logger?: {
    warn: (msg: string, meta?: unknown) => void;
    info?: (msg: string, meta?: unknown) => void;
  };
}

/**
 * Resolve the configured adapter, falling back to the mock/default when the
 * requested one is absent. Throws only if the fallback itself is missing (a
 * programming error), never on bad config — local dev must always boot.
 */
export async function selectAdapter<T>(opts: SelectAdapterOptions<T>): Promise<T> {
  const { label, kind, adapters, fallback, logger } = opts;
  const chosen = kind && adapters[kind] ? kind : fallback;
  if (kind && !adapters[kind]) {
    logger?.warn(`${label}: unknown adapter "${kind}", using "${fallback}"`, {
      available: Object.keys(adapters),
    });
  }
  const factory = adapters[chosen];
  if (!factory) {
    throw new Error(
      `${label}: no adapter "${chosen}" (available: ${Object.keys(adapters).join(', ') || 'none'})`,
    );
  }
  logger?.info?.(`${label}: using "${chosen}" adapter`);
  return factory();
}
