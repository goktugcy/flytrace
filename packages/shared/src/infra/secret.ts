import { type AdapterFactory, selectAdapter } from './provider-kit.ts';

/**
 * Secret access behind an interface so code never binds to where secrets live.
 * Local/CI read from the environment; production can point at Infisical or
 * Vault by flipping SECRET_PROVIDER — both remote adapters degrade to the env
 * on any miss/failure so a misconfigured secret store can't take the app down.
 */
export interface SecretProvider {
  readonly name: string;
  /** Resolve a secret, or undefined if absent everywhere. */
  get(key: string): Promise<string | undefined>;
  /** Resolve a secret or throw — for boot-critical values. */
  getRequired(key: string): Promise<string>;
}

abstract class BaseSecretProvider implements SecretProvider {
  abstract readonly name: string;
  abstract get(key: string): Promise<string | undefined>;
  async getRequired(key: string): Promise<string> {
    const v = await this.get(key);
    if (v === undefined || v === '') throw new Error(`missing required secret: ${key}`);
    return v;
  }
}

/** Reads from a source record (defaults to process.env). Always available. */
export class EnvSecretProvider extends BaseSecretProvider {
  readonly name = 'env';
  constructor(private readonly source: Record<string, string | undefined> = process.env) {
    super();
  }
  async get(key: string): Promise<string | undefined> {
    return this.source[key];
  }
}

/** A function that fetches a single secret from a remote store, or undefined. */
export type SecretResolver = (key: string) => Promise<string | undefined>;

/**
 * Wraps a remote store (Infisical/Vault): in-memory cache + env fallback so a
 * remote miss or outage never blocks. Inject a resolver → trivially testable.
 */
export class RemoteSecretProvider extends BaseSecretProvider {
  private readonly cache = new Map<string, { value: string | undefined; exp: number }>();
  constructor(
    readonly name: string,
    private readonly resolve: SecretResolver,
    private readonly fallback: SecretProvider = new EnvSecretProvider(),
    private readonly ttlMs = 5 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {
    super();
  }
  async get(key: string): Promise<string | undefined> {
    const hit = this.cache.get(key);
    if (hit && hit.exp > this.now()) return hit.value;
    let value: string | undefined;
    try {
      value = await this.resolve(key);
    } catch {
      value = undefined;
    }
    if (value === undefined) value = await this.fallback.get(key);
    this.cache.set(key, { value, exp: this.now() + this.ttlMs });
    return value;
  }
}

export interface SecretConfig {
  /** env | infisical | vault (defaults to env). */
  SECRET_PROVIDER?: string | undefined;
  INFISICAL_API_URL?: string | undefined;
  INFISICAL_TOKEN?: string | undefined;
  INFISICAL_PROJECT_ID?: string | undefined;
  INFISICAL_ENV?: string | undefined;
  VAULT_ADDR?: string | undefined;
  VAULT_TOKEN?: string | undefined;
  VAULT_KV_MOUNT?: string | undefined;
  VAULT_SECRET_PATH?: string | undefined;
}

type Fetcher = typeof fetch;

/** Infisical resolver — reads a single secret via the public API. */
function infisicalResolver(cfg: SecretConfig, fetchImpl: Fetcher): SecretResolver {
  const base = cfg.INFISICAL_API_URL ?? 'https://app.infisical.com';
  const env = cfg.INFISICAL_ENV ?? 'prod';
  return async (key) => {
    if (!cfg.INFISICAL_TOKEN || !cfg.INFISICAL_PROJECT_ID) return undefined;
    const url = `${base}/api/v3/secrets/raw/${encodeURIComponent(key)}?workspaceId=${cfg.INFISICAL_PROJECT_ID}&environment=${env}`;
    const res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${cfg.INFISICAL_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { secret?: { secretValue?: string } };
    return body.secret?.secretValue;
  };
}

/** Vault KV v2 resolver — reads a path once and serves keys from it. */
function vaultResolver(cfg: SecretConfig, fetchImpl: Fetcher): SecretResolver {
  const mount = cfg.VAULT_KV_MOUNT ?? 'secret';
  const path = cfg.VAULT_SECRET_PATH ?? 'flytrace';
  return async (key) => {
    if (!cfg.VAULT_ADDR || !cfg.VAULT_TOKEN) return undefined;
    const url = `${cfg.VAULT_ADDR}/v1/${mount}/data/${path}`;
    const res = await fetchImpl(url, {
      headers: { 'x-vault-token': cfg.VAULT_TOKEN },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { data?: { data?: Record<string, string> } };
    return body.data?.data?.[key];
  };
}

/**
 * Build the configured SecretProvider. `env` is always the safety net, so any
 * remote adapter transparently falls back to environment variables.
 */
export function createSecretProvider(
  cfg: SecretConfig,
  deps: {
    source?: Record<string, string | undefined>;
    fetchImpl?: Fetcher;
    logger?: {
      warn: (m: string, meta?: unknown) => void;
      info?: (m: string, meta?: unknown) => void;
    };
  } = {},
): Promise<SecretProvider> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = new EnvSecretProvider(deps.source);
  const adapters: Record<string, AdapterFactory<SecretProvider>> = {
    env: () => env,
    infisical: () => new RemoteSecretProvider('infisical', infisicalResolver(cfg, fetchImpl), env),
    vault: () => new RemoteSecretProvider('vault', vaultResolver(cfg, fetchImpl), env),
  };
  return selectAdapter({
    label: 'secrets',
    kind: cfg.SECRET_PROVIDER,
    adapters,
    fallback: 'env',
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
}
