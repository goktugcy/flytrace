import { loadNotifierConfig } from './config.ts';
import { createContext } from './context.ts';

const config = loadNotifierConfig();
const ctx = createContext(config);

ctx.logger.info('notifier booting', { group: config.NOTIFIER_GROUP });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    ctx.logger.info('notifier shutting down', { sig });
    await ctx.close();
    process.exit(0);
  });
}

await ctx.consumer.start();
