import { loadTrackerConfig } from './config.ts';
import { createContext } from './context.ts';

const config = loadTrackerConfig();
const ctx = await createContext(config);

ctx.logger.info('tracker booting', {
  poll_ms: config.OPENSKY_POLL_INTERVAL_MS,
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
