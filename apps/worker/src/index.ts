import { loadWorkerConfig } from './config.ts';
import { createContext } from './context.ts';

const config = loadWorkerConfig();
const ctx = await createContext(config);

ctx.logger.info('worker booting', {
  group: config.WORKER_GROUP,
  consumer: config.WORKER_CONSUMER,
  providers: ctx.registry.all().map((p) => p.key),
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    ctx.logger.info('worker shutting down', { sig });
    await ctx.close();
    process.exit(0);
  });
}

await ctx.consumer.start();
