import { describe, expect, test } from 'bun:test';
import { buildRetentionSql } from './retention.ts';

describe('buildRetentionSql', () => {
  test('rejects non-positive / non-finite maxAgeDays', () => {
    expect(() => buildRetentionSql({ maxAgeDays: 0 })).toThrow();
    expect(() => buildRetentionSql({ maxAgeDays: -5 })).toThrow();
    expect(() => buildRetentionSql({ maxAgeDays: Number.NaN })).toThrow();
  });

  test('builds a plain-Postgres age-based DELETE', () => {
    const sql = buildRetentionSql({ maxAgeDays: 30 });
    expect(sql.interval).toBe('30 days');
    expect(sql.postgres).toContain('DELETE FROM flight_positions');
    expect(sql.postgres).toContain("ts < now() - interval '30 days'");
  });

  test('builds a Timescale drop_chunks statement', () => {
    const sql = buildRetentionSql({ maxAgeDays: 7 });
    expect(sql.timescale).toContain('drop_chunks');
    expect(sql.timescale).toContain("'flight_positions'");
    expect(sql.timescale).toContain("older_than => interval '7 days'");
  });

  test('honours custom table and ts column', () => {
    const sql = buildRetentionSql({
      maxAgeDays: 90,
      table: 'flight_tracks_downsampled',
      tsColumn: 'recorded_at',
    });
    expect(sql.postgres).toContain('DELETE FROM flight_tracks_downsampled');
    expect(sql.postgres).toContain("recorded_at < now() - interval '90 days'");
    expect(sql.timescale).toContain("'flight_tracks_downsampled'");
  });
});
