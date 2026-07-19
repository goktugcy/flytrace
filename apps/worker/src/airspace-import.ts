import { fetchOpenAipAirspacePages, importAirspaceDataset } from '@flytrace/airspace';
import { createAirspaceImportRepo } from '@flytrace/db';
import type { Database } from '@flytrace/db';
import type { AirspaceImportJob, Logger } from '@flytrace/shared';
import type { Job } from 'bullmq';
import type { WorkerConfig } from './config.ts';

export interface AirspaceImportProgress {
  status: 'running' | 'completed' | 'failed';
  provider: 'openaip';
  scope: 'global';
  datasetVersion: string;
  page: number;
  totalPages: number | null;
  totalCount: number | null;
  pagesImported: number;
  upserted: number;
  invalid: number;
  retired: number;
  startedAt: string;
  updatedAt: string;
  message: string;
}

export interface AirspaceImportSummary extends AirspaceImportProgress {
  finishedAt: string;
}

export class AirspaceImportService {
  constructor(
    private readonly deps: {
      db: Database;
      config: WorkerConfig;
      logger: Logger;
    },
  ) {}

  async process(job: Job<AirspaceImportJob>): Promise<AirspaceImportSummary> {
    const config = this.deps.config;
    if (!config.OPENAIP_API_KEY) throw new Error('OPENAIP_API_KEY is required for OpenAIP import');

    const startedAt = new Date().toISOString();
    const repo = createAirspaceImportRepo(this.deps.db);
    const sourceIds = new Set<string>();
    let pageNo = 0;
    let totalPages: number | null = null;
    let totalCount: number | null = null;
    let pagesImported = 0;
    let upserted = 0;
    let invalid = 0;
    let retired = 0;

    const update = async (
      message: string,
      status: AirspaceImportProgress['status'] = 'running',
    ) => {
      await job.updateProgress({
        status,
        provider: 'openaip',
        scope: 'global',
        datasetVersion: job.data.datasetVersion,
        page: pageNo,
        totalPages,
        totalCount,
        pagesImported,
        upserted,
        invalid,
        retired,
        startedAt,
        updatedAt: new Date().toISOString(),
        message,
      } satisfies AirspaceImportProgress);
    };

    await update('starting OpenAIP global import');

    for await (const page of fetchOpenAipAirspacePages({
      apiKey: config.OPENAIP_API_KEY,
      globalImport: true,
      baseUrl: config.OPENAIP_BASE_URL,
      pageLimit: config.OPENAIP_PAGE_LIMIT,
      pageDelayMs: config.OPENAIP_IMPORT_PAGE_DELAY_MS,
      maxRetries: config.OPENAIP_IMPORT_MAX_RETRIES,
      throwOnError: true,
      logger: this.deps.logger,
    })) {
      pageNo = page.page;
      totalPages = page.totalPages;
      totalCount = page.totalCount;
      for (const airspace of page.airspaces) sourceIds.add(airspace.sourceId ?? airspace.id);

      const result = await importAirspaceDataset(repo, page.airspaces, {
        provider: 'openaip',
        datasetVersion: job.data.datasetVersion,
        importedAt: new Date(startedAt),
        batchSize: config.AIRSPACE_IMPORT_BATCH_SIZE,
        retirePreviousVersions: false,
        retireMissing: false,
      });
      pagesImported += 1;
      upserted += result.upserted;
      invalid += result.invalid.length;
      await update(`imported OpenAIP page ${pageNo}`);
    }

    const retiredAt = new Date();
    if (config.AIRSPACE_RETIRE_PREVIOUS_VERSIONS) {
      retired += await repo.retirePreviousVersions('openaip', job.data.datasetVersion, retiredAt);
    }
    if (config.AIRSPACE_RETIRE_MISSING) {
      retired += await repo.retireMissing(
        'openaip',
        job.data.datasetVersion,
        [...sourceIds],
        retiredAt,
      );
    }

    const summary: AirspaceImportSummary = {
      status: 'completed',
      provider: 'openaip',
      scope: 'global',
      datasetVersion: job.data.datasetVersion,
      page: pageNo,
      totalPages,
      totalCount,
      pagesImported,
      upserted,
      invalid,
      retired,
      startedAt,
      updatedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      message: 'OpenAIP global import completed',
    };
    await job.updateProgress(summary);
    return summary;
  }
}
