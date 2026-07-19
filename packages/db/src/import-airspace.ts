/**
 * Airspace dataset import CLI.
 *
 * Reads AIRSPACE_PROVIDER + dataset path/version env, parses through the
 * provider-normalization boundary, validates geometry with PostGIS, and upserts
 * geofences idempotently by (provider, dataset_version, source_id).
 */
import { importAirspaceDataset, selectAirspaceProvider } from '@flytrace/airspace';
import { configSchemas, createLogger, loadConfig } from '@flytrace/shared';
import { createDb } from './index.ts';
import { createAirspaceImportRepo } from './repos/airspace-import.ts';

const importConfigSchema = configSchemas.base
  .merge(configSchemas.database)
  .merge(configSchemas.infra);

async function main() {
  const config = loadConfig(importConfigSchema);
  const logger = createLogger({
    level: config.LOG_LEVEL,
    base: { app: 'airspace-import', env: config.APP_ENV },
  });
  const provider = await selectAirspaceProvider({
    kind: config.AIRSPACE_PROVIDER,
    openaipDatasetPath: config.OPENAIP_DATASET_PATH,
    openflightmapsDatasetPath: config.OPENFLIGHTMAPS_DATASET_PATH,
    aixmDatasetPath: config.AIXM_DATASET_PATH,
    logger,
  });
  await provider.load();
  const airspaces = provider.allAirspaces();
  logger.info('airspace import: dataset loaded', {
    provider: config.AIRSPACE_PROVIDER,
    datasetVersion: config.AIRSPACE_DATASET_VERSION,
    count: airspaces.length,
  });

  const { db, close } = createDb({ url: config.DATABASE_URL, max: 1 });
  try {
    const result = await importAirspaceDataset(createAirspaceImportRepo(db), airspaces, {
      provider: config.AIRSPACE_PROVIDER,
      datasetVersion: config.AIRSPACE_DATASET_VERSION,
      importedAt: new Date(),
      batchSize: config.AIRSPACE_IMPORT_BATCH_SIZE,
      retirePreviousVersions: config.AIRSPACE_RETIRE_PREVIOUS_VERSIONS,
      retireMissing: config.AIRSPACE_RETIRE_MISSING,
    });
    logger.info('airspace import: completed', {
      provider: result.provider,
      datasetVersion: result.datasetVersion,
      upserted: result.upserted,
      retired: result.retired,
      invalid: result.invalid.length,
    });
    if (result.invalid.length > 0) {
      logger.warn('airspace import: invalid rows skipped', {
        count: result.invalid.length,
        sample: result.invalid.slice(0, 20),
      });
    }
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error('[airspace-import] failed', err);
  process.exit(1);
});
