import { loadTrackerConfig } from './config.ts';
import { createContext } from './context.ts';
import { startMetricsServer } from './metrics-server.ts';

const config = loadTrackerConfig();
const ctx = await createContext(config);

// Prometheus scrape endpoint for the tracker's process-local registry.
const metricsServer = startMetricsServer({
  port: config.TRACKER_METRICS_PORT,
  host: config.TRACKER_METRICS_HOST,
  registry: ctx.metrics.registry,
  logger: ctx.logger,
});

ctx.logger.info('tracker booting', {
  source: config.TRACKER_SOURCE,
  providers: config.TRACKER_SOURCE === 'composite' ? config.TRACKER_PROVIDERS : undefined,
  poll_ms:
    config.TRACKER_SOURCE === 'adsb'
      ? config.ADSB_POLL_INTERVAL_MS
      : config.OPENSKY_POLL_INTERVAL_MS,
  remove_after_ms: config.TRACKER_REMOVE_AFTER_MS,
  fixture: config.TRACKER_USE_FIXTURE,
});

// Graceful shutdown — release leadership so a standby can take over promptly.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    ctx.logger.info('tracker shutting down', { sig });
    metricsServer?.stop();
    await ctx.close();
    process.exit(0);
  });
}

await ctx.tracker.start();
