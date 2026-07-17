import { createApp } from './app.ts';
import { loadApiConfig } from './config.ts';
import { createContext } from './context.ts';

const config = loadApiConfig();
const ctx = createContext(config);
const app = createApp(ctx);

ctx.logger.info('api starting', { port: config.API_PORT, host: config.API_HOST });

const server = Bun.serve({
  port: config.API_PORT,
  hostname: config.API_HOST,
  fetch: app.fetch,
});

ctx.logger.info('api listening', { url: `http://${config.API_HOST}:${config.API_PORT}` });

// Graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    ctx.logger.info('api shutting down', { sig });
    server.stop(true);
    await ctx.close();
    process.exit(0);
  });
}
