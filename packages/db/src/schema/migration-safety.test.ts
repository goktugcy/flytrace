import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';

const migrationsDir = new URL('../../migrations/', import.meta.url);
const allMigrations = readdirSync(migrationsDir)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => readFileSync(new URL(file, migrationsDir), 'utf8'))
  .join('\n');
const phase7Migration = readFileSync(new URL('0001_dusty_madrox.sql', migrationsDir), 'utf8');
const phase15Migration = readFileSync(new URL('0002_violet_goliath.sql', migrationsDir), 'utf8');

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
      expect(allMigrations).toContain(`"${indexName}"`);
    }

    expect(phase7Migration).toContain(
      'CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")',
    );
  });

  test('adds airspace import metadata and idempotency indexes', () => {
    const expectedColumns = [
      '"provider" text',
      '"source_id" text',
      '"dataset_version" text',
      '"imported_at" timestamp with time zone DEFAULT now() NOT NULL',
      '"effective_from" timestamp with time zone',
      '"effective_to" timestamp with time zone',
    ];
    for (const column of expectedColumns) {
      expect(phase15Migration).toContain(column);
    }
    expect(phase15Migration).toContain('"idx_geofences_provider_dataset"');
    expect(phase15Migration).toContain('"uq_geofences_provider_dataset_source"');
  });
});
