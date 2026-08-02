import { describe, expect, it } from 'bun:test';
import { fixedClock } from '@flytrace/shared';
import { DeviceService, createInMemoryDeviceRepo, deviceFingerprint } from './devices.ts';
import type { IpStoragePolicy } from './ip.ts';

function makeService(ipPolicy?: IpStoragePolicy) {
  const repo = createInMemoryDeviceRepo();
  const clock = fixedClock(10_000);
  const svc = new DeviceService({ repo, clock, ...(ipPolicy ? { ipPolicy } : {}) });
  return { repo, clock, svc };
}

describe('deviceFingerprint', () => {
  it('is stable for identical inputs and differs across inputs', () => {
    expect(deviceFingerprint('UA/1', '203.0.113.0/24')).toBe(
      deviceFingerprint('UA/1', '203.0.113.0/24'),
    );
    expect(deviceFingerprint('UA/1', '203.0.113.0/24')).not.toBe(
      deviceFingerprint('UA/2', '203.0.113.0/24'),
    );
  });
});

describe('DeviceService.registerDevice', () => {
  it('dedups the same UA within the same /24 to one device', async () => {
    const { svc } = makeService();
    const id1 = await svc.registerDevice('user-1', { ua: 'UA/1', ip: '203.0.113.5' });
    const id2 = await svc.registerDevice('user-1', { ua: 'UA/1', ip: '203.0.113.240' });
    expect(id2).toBe(id1);
    const list = await svc.listDevices('user-1');
    expect(list).toHaveLength(1);
  });

  it('creates a new device for a different UA', async () => {
    const { svc } = makeService();
    const id1 = await svc.registerDevice('user-1', { ua: 'UA/1', ip: '203.0.113.5' });
    const id2 = await svc.registerDevice('user-1', { ua: 'UA/2', ip: '203.0.113.5' });
    expect(id2).not.toBe(id1);
    expect(await svc.listDevices('user-1')).toHaveLength(2);
  });

  it('creates a new device for a different network (/24)', async () => {
    const { svc } = makeService();
    const id1 = await svc.registerDevice('user-1', { ua: 'UA/1', ip: '203.0.113.5' });
    const id2 = await svc.registerDevice('user-1', { ua: 'UA/1', ip: '198.51.100.5' });
    expect(id2).not.toBe(id1);
  });

  it('updates last-seen on re-register', async () => {
    const { svc, clock, repo } = makeService();
    const id = await svc.registerDevice('user-1', { ua: 'UA/1', ip: '203.0.113.5' });
    clock.advance(5_000);
    await svc.registerDevice('user-1', { ua: 'UA/1', ip: '203.0.113.9' });
    const rec = (await repo.listByUser('user-1')).find((d) => d.id === id);
    expect(rec?.lastSeenAt.getTime()).toBe(15_000);
    // Default policy stores the NETWORK, not the exact address (data minimisation).
    expect(rec?.lastIp).toBe('203.0.113.0/24');
  });

  it('reports whether a device is a first sighting', async () => {
    const { svc } = makeService();
    const first = await svc.register('user-1', { ua: 'UA/1', ip: '203.0.113.5' });
    expect(first.isNew).toBe(true);

    const second = await svc.register('user-1', { ua: 'UA/1', ip: '203.0.113.6' });
    expect(second.isNew).toBe(false);
    expect(second.deviceId).toBe(first.deviceId);

    const other = await svc.register('user-1', { ua: 'UA/2', ip: '203.0.113.5' });
    expect(other.isNew).toBe(true);
  });

  it('handles a missing UA/IP without throwing', async () => {
    const { svc } = makeService();
    const id = await svc.registerDevice('user-1', {});
    expect(typeof id).toBe('string');
  });
});

describe('DeviceService IP storage policy', () => {
  it('"prefix" (default) never persists an exact address', async () => {
    const { svc } = makeService('prefix');
    await svc.registerDevice('user-1', { ua: 'UA/1', ip: '203.0.113.77' });
    const [device] = await svc.listDevices('user-1');
    expect(device?.lastIp).toBe('203.0.113.0/24');
    expect(device?.lastIp).not.toContain('.77');
  });

  it('"full" keeps the exact address for deployments that require it', async () => {
    const { svc } = makeService('full');
    await svc.registerDevice('user-1', { ua: 'UA/1', ip: '203.0.113.77' });
    expect((await svc.listDevices('user-1'))[0]?.lastIp).toBe('203.0.113.77');
  });

  it('"none" stores nothing, and device detection still works', async () => {
    const { svc } = makeService('none');
    const first = await svc.register('user-1', { ua: 'UA/1', ip: '203.0.113.77' });
    expect((await svc.listDevices('user-1'))[0]?.lastIp).toBeNull();
    // The user-agent half of the fingerprint still distinguishes devices.
    const other = await svc.register('user-1', { ua: 'UA/2', ip: '203.0.113.77' });
    expect(other.deviceId).not.toBe(first.deviceId);
  });

  it('coarsens IPv6 to a /48', async () => {
    const { svc } = makeService('prefix');
    await svc.registerDevice('user-1', { ua: 'UA/1', ip: '2001:db8:1234:5678::1' });
    expect((await svc.listDevices('user-1'))[0]?.lastIp).toBe('2001:db8:1234:0:0:0:0:0/48');
  });
});

describe('DeviceService trust/revoke', () => {
  it('trustDevice flips the trusted flag; revokeDevice removes it', async () => {
    const { svc } = makeService();
    const id = await svc.registerDevice('user-1', { ua: 'UA/1', ip: '203.0.113.5' });
    await svc.trustDevice(id);
    expect((await svc.listDevices('user-1'))[0]?.trusted).toBe(true);
    await svc.revokeDevice(id);
    expect(await svc.listDevices('user-1')).toHaveLength(0);
  });
});
