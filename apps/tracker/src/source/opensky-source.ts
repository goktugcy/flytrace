import type { Logger } from '@flytrace/shared';
import type { Bbox } from '../config.ts';
import { normalizeStatesResponse } from '../domain/position.ts';
import type { Position } from '../domain/position.ts';
import type { PositionSource } from './port.ts';

const STATES_URL = 'https://opensky-network.org/api/states/all';
const TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

export interface OpenSkySourceOptions {
  bbox: Bbox;
  logger: Logger;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  /** Injectable fetch for testing; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Live OpenSky `/states/all` client (docs/08 §8.3). Bbox-scoped to avoid
 * full-world polls; OAuth2 client-credentials when configured (higher tier),
 * anonymous otherwise. Politeness (backoff/jitter, leader lock) lives in the
 * engine — this adapter just fetches + normalizes and throws on HTTP failure.
 */
export class OpenSkyPositionSource implements PositionSource {
  readonly name = 'opensky';
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly opts: OpenSkySourceOptions) {}

  private get fetch(): typeof fetch {
    return this.opts.fetchImpl ?? fetch;
  }

  private get authed(): boolean {
    return Boolean(this.opts.clientId && this.opts.clientSecret);
  }

  private async accessToken(): Promise<string | null> {
    if (!this.authed) return null;
    const now = Date.now();
    if (this.token && this.token.expiresAt - 30_000 > now) return this.token.value;

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.opts.clientId as string,
      client_secret: this.opts.clientSecret as string,
    });
    const res = await this.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new Error(`opensky token failed: ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, expiresAt: now + json.expires_in * 1000 };
    return this.token.value;
  }

  async poll(): Promise<Position[]> {
    const { lamin, lomin, lamax, lomax } = this.opts.bbox;
    const url = new URL(STATES_URL);
    url.searchParams.set('lamin', String(lamin));
    url.searchParams.set('lomin', String(lomin));
    url.searchParams.set('lamax', String(lamax));
    url.searchParams.set('lomax', String(lomax));

    const headers: Record<string, string> = { accept: 'application/json' };
    const token = await this.accessToken();
    if (token) headers.authorization = `Bearer ${token}`;

    const res = await this.fetch(url, { headers });
    if (!res.ok) throw new Error(`opensky states failed: ${res.status}`);
    return normalizeStatesResponse(await res.json());
  }
}
