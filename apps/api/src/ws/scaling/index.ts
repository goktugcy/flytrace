/**
 * WebSocket horizontal-scaling toolkit (docs/12 §12.8). Interface-first, with an
 * in-memory/local default for every port so `apps/api` runs offline, and an
 * env-gated Redis path for multi-node deployments.
 *
 * - {@link createPubSub}: node-to-node Pub/Sub for shard fan-out.
 * - {@link ShardManager}: region-based sharding of positions by viewport.
 * - {@link createPresence}: connected-client count / listing.
 * - {@link HeartbeatManager}: ping/pong liveness eviction.
 * - {@link createRateLimiter}: per-IP connect + per-conn message limits.
 * - {@link ReconnectPolicy}/{@link exponentialBackoff}: client reconnect strategy.
 */
export * from './pubsub.ts';
export * from './shard-manager.ts';
export * from './presence.ts';
export * from './heartbeat.ts';
export * from './rate-limit.ts';
export * from './reconnect.ts';
