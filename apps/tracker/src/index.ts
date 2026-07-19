import { loadTrackerConfig } from './config.ts';
import { createContext } from './context.ts';

const config = loadTrackerConfig();
const ctx = await createContext(config);

ctx.logger.info('tracker booting', {
  source: config.TRACKER_SOURCE,
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
    await ctx.close();
    process.exit(0);
  });
}

await ctx.tracker.start();
