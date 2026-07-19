import { describe, expect, it } from 'bun:test';
import { fixedClock } from '@flytrace/shared';
import { DeviceService, createInMemoryDeviceRepo, deviceFingerprint } from './devices.ts';

function makeService() {
  const repo = createInMemoryDeviceRepo();
  const clock = fixedClock(10_000);
  const svc = new DeviceService({ repo, clock });
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
    expect(rec?.lastIp).toBe('203.0.113.9');
  });

  it('handles a missing UA/IP without throwing', async () => {
    const { svc } = makeService();
    const id = await svc.registerDevice('user-1', {});
    expect(typeof id).toBe('string');
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
