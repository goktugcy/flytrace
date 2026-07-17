/** Polite identification for all outbound provider traffic (docs/08 §8.9). */
export const USER_AGENT = 'FlyTraceBot/1.0 (+https://flytrace.app/bot)';

/** Default upstream timeout — providers must never block the fetch queue. */
export const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Resolve a provider's base status URL from the shared `config.statusUrls` map,
 * keyed by provider key (docs/08 §8.9: the legal basis/endpoint lives in config;
 * one ctx is shared across providers, so the map is keyed). Throwing keeps an
 * unconfigured provider inert — BaseProvider turns the throw into a null result.
 */
export function providerStatusUrl(config: Record<string, unknown>, key: string): string {
  const urls = config.statusUrls;
  const url = urls && typeof urls === 'object' ? (urls as Record<string, unknown>)[key] : undefined;
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error(`status URL for provider "${key}" is not configured`);
  }
  return url;
}
