import { createHash } from 'node:crypto';
import type { Clock } from '@flytrace/shared';
import { type IpStoragePolicy, applyIpPolicy, ipPrefix, normalizeIp } from './ip.ts';

/**
 * Device management (docs §7b). A device is identified by a stable fingerprint
 * hash of its user-agent + COARSE (prefix) IP — coarse so the same device does
 * not fork into many records as its address churns. Registration dedups on the
 * (user, fingerprint) pair and refreshes last-seen.
 *
 * What gets PERSISTED as `last_ip` is governed by {@link IpStoragePolicy};
 * the default stores only the network prefix, never the exact address.
 */

export interface DeviceRecord {
  id: string;
  userId: string;
  fingerprint: string;
  ua: string | null;
  lastIp: string | null;
  trusted: boolean;
  lastSeenAt: Date;
  createdAt: Date;
}

export interface NewDevice {
  userId: string;
  fingerprint: string;
  ua: string | null;
  lastIp: string | null;
  trusted: boolean;
  lastSeenAt: Date;
  createdAt: Date;
}

/** Persistence port. `insert` returns the generated device id. */
export interface DeviceRepo {
  findByFingerprint(userId: string, fingerprint: string): Promise<DeviceRecord | null>;
  insert(rec: NewDevice): Promise<string>;
  touch(id: string, lastSeenAt: Date, lastIp: string | null): Promise<void>;
  listByUser(userId: string): Promise<DeviceRecord[]>;
  setTrusted(id: string, trusted: boolean): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface DeviceServiceDeps {
  repo: DeviceRepo;
  clock: Clock;
  /** Prefix widths used to coarsen the IP before fingerprinting. */
  v4bits?: number | undefined;
  v6bits?: number | undefined;
  /** What may be persisted as `last_ip`. Defaults to the network prefix. */
  ipPolicy?: IpStoragePolicy | undefined;
}

/**
 * Pure fingerprint: a sha256 digest of the user-agent + coarse-IP tuple. Stable
 * across address churn within the same network. Exposed for reuse by detectors.
 */
export function deviceFingerprint(ua: string, coarseIp: string): string {
  return createHash('sha256').update(`${ua}\n${coarseIp}`).digest('hex');
}

export interface RegisterDeviceInput {
  ua?: string | null | undefined;
  ip?: string | null | undefined;
}

/** Outcome of a device registration — tells callers whether it is a first sight. */
export interface RegisteredDevice {
  deviceId: string;
  fingerprint: string;
  /** True when no prior row existed for this (user, fingerprint) pair. */
  isNew: boolean;
}

export class DeviceService {
  constructor(private readonly deps: DeviceServiceDeps) {}

  private coarse(ip: string | null | undefined): string {
    if (!ip) return '';
    return ipPrefix(normalizeIp(ip), this.deps.v4bits, this.deps.v6bits);
  }

  private storableIp(ip: string | null | undefined): string | null {
    return applyIpPolicy(ip, this.deps.ipPolicy ?? 'prefix', this.deps.v4bits, this.deps.v6bits);
  }

  /**
   * Register (or refresh) the calling device, returning its stable device id.
   * Dedups on (user, fingerprint): a returning device updates last-seen rather
   * than creating a duplicate row.
   */
  async registerDevice(userId: string, input: RegisterDeviceInput): Promise<string> {
    return (await this.register(userId, input)).deviceId;
  }

  /**
   * As {@link registerDevice}, but also reports whether this was a first
   * sighting — the signal that drives the new-device audit event and the
   * security notification.
   */
  async register(userId: string, input: RegisterDeviceInput): Promise<RegisteredDevice> {
    const ua = input.ua ?? null;
    const ip = this.storableIp(input.ip);
    const fingerprint = deviceFingerprint(ua ?? '', this.coarse(input.ip));
    const now = new Date(this.deps.clock.now());

    const existing = await this.deps.repo.findByFingerprint(userId, fingerprint);
    if (existing) {
      await this.deps.repo.touch(existing.id, now, ip);
      return { deviceId: existing.id, fingerprint, isNew: false };
    }
    const deviceId = await this.deps.repo.insert({
      userId,
      fingerprint,
      ua,
      lastIp: ip,
      trusted: false,
      lastSeenAt: now,
      createdAt: now,
    });
    return { deviceId, fingerprint, isNew: true };
  }

  listDevices(userId: string): Promise<DeviceRecord[]> {
    return this.deps.repo.listByUser(userId);
  }

  trustDevice(deviceId: string): Promise<void> {
    return this.deps.repo.setTrusted(deviceId, true);
  }

  /** Remove a device (revoke). Callers should also revoke its refresh tokens. */
  revokeDevice(deviceId: string): Promise<void> {
    return this.deps.repo.remove(deviceId);
  }

  /** Record activity for an already-known device. */
  markSeen(deviceId: string, ip?: string | null): Promise<void> {
    return this.deps.repo.touch(deviceId, new Date(this.deps.clock.now()), this.storableIp(ip));
  }
}

/** In-memory DeviceRepo for tests and the no-DB local default. */
export function createInMemoryDeviceRepo(idGen?: () => string): DeviceRepo {
  const rows = new Map<string, DeviceRecord>();
  let seq = 0;
  const nextId = idGen ?? (() => `dev_${seq++}`);

  return {
    async findByFingerprint(userId, fingerprint) {
      for (const r of rows.values()) {
        if (r.userId === userId && r.fingerprint === fingerprint) return { ...r };
      }
      return null;
    },
    async insert(rec) {
      const id = nextId();
      rows.set(id, { ...rec, id });
      return id;
    },
    async touch(id, lastSeenAt, lastIp) {
      const r = rows.get(id);
      if (r) rows.set(id, { ...r, lastSeenAt, lastIp });
    },
    async listByUser(userId) {
      return [...rows.values()].filter((r) => r.userId === userId).map((r) => ({ ...r }));
    },
    async setTrusted(id, trusted) {
      const r = rows.get(id);
      if (r) rows.set(id, { ...r, trusted });
    },
    async remove(id) {
      rows.delete(id);
    },
  };
}
