import { createApp } from './app.ts';
import { loadApiConfig } from './config.ts';
import { createContext } from './context.ts';
import { WsGateway } from './ws/gateway.ts';

const config = loadApiConfig();
const ctx = createContext(config);
const app = createApp(ctx);
const gateway = new WsGateway(ctx);
await gateway.start();

ctx.logger.info('api starting', { port: config.API_PORT, host: config.API_HOST });

const server = Bun.serve({
  port: config.API_PORT,
  hostname: config.API_HOST,
  idleTimeout: 120, // dead-connection backstop; client heartbeat keeps it alive
  fetch(req, srv) {
    if (new URL(req.url).pathname === '/ws') return gateway.handleUpgrade(req, srv);
    return app.fetch(req, srv);
  },
  websocket: gateway.websocket,
});

ctx.logger.info('api listening', {
  url: `http://${config.API_HOST}:${config.API_PORT}`,
  ws: `ws://${config.API_HOST}:${config.API_PORT}/ws`,
});

// Graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    ctx.logger.info('api shutting down', { sig });
    await gateway.stop();
    server.stop(true);
    await ctx.close();
    process.exit(0);
  });
}
