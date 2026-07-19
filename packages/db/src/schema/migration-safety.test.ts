import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const phase7Migration = readFileSync(
  new URL('../../migrations/0001_dusty_madrox.sql', import.meta.url),
  'utf8',
);

describe('phase 7 migration', () => {
  test('creates geofence and security tables', () => {
    const expectedTables = [
      'geofences',
      'mfa_backup_codes',
      'user_mfa',
      'refresh_tokens',
      'user_devices',
      'audit_log',
    ];

    for (const table of expectedTables) {
      expect(phase7Migration).toContain(`CREATE TABLE "${table}"`);
    }
  });

  test('stores MFA TOTP secrets as ciphertext only', () => {
    expect(phase7Migration).toContain('"secret_ciphertext" text NOT NULL');
    expect(phase7Migration).not.toContain('"secret" text NOT NULL');
  });

  test('stores backup codes as hashes only', () => {
    expect(phase7Migration).toContain('"code_hash" text NOT NULL');
    expect(phase7Migration).not.toContain('"code" text NOT NULL');
  });

  test('keeps expected lookup indexes and token uniqueness', () => {
    const expectedIndexes = [
      'idx_geofences_geom',
      'idx_geofences_type',
      'idx_mfa_backup_codes_user',
      'idx_refresh_tokens_user',
      'idx_refresh_tokens_family',
      'idx_refresh_tokens_device',
      'idx_user_devices_user',
      'uq_user_devices_fingerprint',
      'idx_audit_log_actor_created',
    ];

    for (const indexName of expectedIndexes) {
      expect(phase7Migration).toContain(`"${indexName}"`);
    }

    expect(phase7Migration).toContain(
      'CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")',
    );
  });
});
