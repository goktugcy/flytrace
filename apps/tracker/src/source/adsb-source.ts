import type { Clock, Logger } from '@flytrace/shared';
import { type Position, normalizeAdsbResponse } from '../domain/position.ts';
import { withSourceMetadata } from './metadata.ts';
import type { PositionSource } from './port.ts';

/** Polite identification for the community ADS-B feed (attribution + contact). */
const USER_AGENT = 'FlyTraceBot/1.0 (+https://flytrace.app/bot; community ADS-B data)';

/**
 * URL shape of the point+radius query. Community feeds share the readsb/tar1090
 * response format but differ in path: adsb.lol/adsb.fi use `/lat/../lon/../dist/..`,
 * airplanes.live uses `/point/{lat}/{lon}/{radius}`.
 */
export type AdsbQueryStyle = 'lol' | 'point';

export interface AdsbSourceOptions {
  /** Base URL, e.g. "https://api.adsb.lol/v2" or "https://api.airplanes.live/v2". */
  apiUrl: string;
  /** Query centre + radius (nm). Community feeds cap the radius at 250 nm. */
  lat: number;
  lon: number;
  radiusNm: number;
  /** Path shape for the feed (default 'lol'). */
  queryStyle?: AdsbQueryStyle;
  logger: Logger;
  clock: Clock;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Live positions from a community ADS-B feed (readsb/tar1090 JSON, e.g.
 * adsb.lol) — a keyless, higher-limit alternative to OpenSky (docs/08 §8.3).
 * Point+radius query; already in aviation units. Throws on HTTP failure; the
 * engine owns backoff/leader-lock politeness.
 */
export class AdsbPositionSource implements PositionSource {
  readonly name = 'adsb';
  readonly timeMode = 'wall';

  constructor(private readonly opts: AdsbSourceOptions) {}

  private get fetch(): typeof fetch {
    return this.opts.fetchImpl ?? fetch;
  }

  async poll(): Promise<Position[]> {
    const base = this.opts.apiUrl.replace(/\/+$/, '');
    const dist = Math.min(Math.max(Math.round(this.opts.radiusNm), 1), 250);
    const url =
      this.opts.queryStyle === 'point'
        ? `${base}/point/${this.opts.lat}/${this.opts.lon}/${dist}`
        : `${base}/lat/${this.opts.lat}/lon/${this.opts.lon}/dist/${dist}`;
    const res = await this.fetch(url, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    });
    if (!res.ok) throw new Error(`adsb states failed: ${res.status}`);
    const receivedAtMs = this.opts.clock.now();
    return withSourceMetadata(
      normalizeAdsbResponse(await res.json(), receivedAtMs),
      this.name,
      receivedAtMs,
    );
  }
}
