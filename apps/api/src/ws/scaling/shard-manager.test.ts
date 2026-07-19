import { describe, expect, test } from 'bun:test';
import type { Bbox } from '../channels.ts';
import { ShardManager } from './shard-manager.ts';

describe('ShardManager sharding', () => {
  test('shardForPoint is deterministic and within range', () => {
    const sm = new ShardManager({ shardCount: 16 });
    for (const [lat, lon] of [
      [0, 0],
      [51.5, -0.12],
      [-33.9, 151.2],
      [90, 180],
      [-90, -180],
    ] as const) {
      const id = sm.shardForPoint(lat, lon);
      expect(id).toBe(sm.shardForPoint(lat, lon));
      expect(id).toBeGreaterThanOrEqual(0);
      expect(id).toBeLessThan(16);
    }
  });

  test('distinct regions map to distinct shards', () => {
    const sm = new ShardManager({ shardCount: 16 });
    const london = sm.shardForPoint(51.5, -0.12);
    const sydney = sm.shardForPoint(-33.9, 151.2);
    expect(london).not.toBe(sydney);
  });

  test('shardForBbox uses the center point', () => {
    const sm = new ShardManager({ shardCount: 16 });
    const box: Bbox = [-1, 50, 1, 52];
    expect(sm.shardForBbox(box)).toBe(sm.shardForPoint(51, 0));
  });

  test('shardCount=1 collapses everything onto shard 0', () => {
    const sm = new ShardManager({ shardCount: 1 });
    expect(sm.shardForPoint(10, 20)).toBe(0);
    expect(sm.shardsForViewport([-180, -90, 180, 90])).toEqual([0]);
  });
});

describe('ShardManager viewport coverage', () => {
  test('a wide viewport covers multiple shards', () => {
    const sm = new ShardManager({ shardCount: 64 });
    const wide = sm.shardsForViewport([-180, -90, 180, 90]);
    const narrow = sm.shardsForViewport([0, 0, 0.01, 0.01]);
    expect(wide.length).toBeGreaterThan(narrow.length);
    expect(narrow.length).toBe(1);
  });

  test('coverage includes the point-shards at the corners', () => {
    const sm = new ShardManager({ shardCount: 64 });
    const box: Bbox = [-10, 40, 10, 55];
    const covered = new Set(sm.shardsForViewport(box));
    expect(covered.has(sm.shardForPoint(40, -10))).toBe(true);
    expect(covered.has(sm.shardForPoint(55, 10))).toBe(true);
  });

  test('antimeridian viewport (west > east) wraps columns', () => {
    const sm = new ShardManager({ shardCount: 64 });
    const box: Bbox = [170, -10, -170, 10];
    const covered = new Set(sm.shardsForViewport(box));
    expect(covered.has(sm.shardForPoint(0, 175))).toBe(true);
    expect(covered.has(sm.shardForPoint(0, -175))).toBe(true);
    expect(covered.has(sm.shardForPoint(0, 0))).toBe(false);
  });
});

describe('ShardManager channel keys', () => {
  test('channelFor applies the prefix', () => {
    const sm = new ShardManager({ shardCount: 16, prefix: 'flytrace:local:' });
    expect(sm.channelFor(3)).toBe('flytrace:local:rt:positions:shard:3');
  });

  test('channelsForViewport maps every covered shard', () => {
    const sm = new ShardManager({ shardCount: 16, prefix: 'p:' });
    const box: Bbox = [-10, 40, 10, 55];
    const chans = sm.channelsForViewport(box);
    const ids = sm.shardsForViewport(box);
    expect(chans).toEqual(ids.map((id) => `p:rt:positions:shard:${id}`));
  });
});

describe('ShardManager viewport assignment diff', () => {
  test('first assign subscribes everything, no unsubscribe', () => {
    const sm = new ShardManager({ shardCount: 16 });
    const diff = sm.assign('c1', [-10, 40, 10, 55]);
    expect(diff.unsubscribe).toEqual([]);
    expect(diff.subscribe.length).toBeGreaterThan(0);
    expect(new Set(sm.channelsOf('c1'))).toEqual(new Set(diff.subscribe));
  });

  test('re-assigning the same viewport is a no-op diff', () => {
    const sm = new ShardManager({ shardCount: 16 });
    const box: Bbox = [-10, 40, 10, 55];
    sm.assign('c1', box);
    const diff = sm.assign('c1', box);
    expect(diff.subscribe).toEqual([]);
    expect(diff.unsubscribe).toEqual([]);
  });

  test('moving the viewport only diffs the changed channels', () => {
    const sm = new ShardManager({ shardCount: 64 });
    sm.assign('c1', [-10, 40, 10, 55]);
    const before = new Set(sm.channelsOf('c1'));
    const diff = sm.assign('c1', [150, -40, 160, -30]);
    for (const ch of diff.subscribe) expect(before.has(ch)).toBe(false);
    for (const ch of diff.unsubscribe) expect(before.has(ch)).toBe(true);
    expect(new Set(sm.channelsOf('c1'))).toEqual(
      new Set(sm.channelsForViewport([150, -40, 160, -30])),
    );
  });

  test('release returns and clears the connection channels', () => {
    const sm = new ShardManager({ shardCount: 16 });
    const diff = sm.assign('c1', [-10, 40, 10, 55]);
    const released = sm.release('c1');
    expect(new Set(released)).toEqual(new Set(diff.subscribe));
    expect(sm.channelsOf('c1')).toEqual([]);
    expect(sm.release('c1')).toEqual([]);
  });
});
