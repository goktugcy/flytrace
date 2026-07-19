/**
 * Digest email system (docs/10, docs/17 §17.5). Public surface for wiring into
 * the notifier context: an env-switchable EmailProvider (mock default), a typed
 * template renderer, the DigestService, an interval scheduler + retry helper, an
 * in-memory retry queue, unsubscribe tokens, and preference helpers.
 */
export * from './email-provider/index.ts';
export * from './template.ts';
export * from './digest-service.ts';
export * from './scheduler.ts';
export * from './queue.ts';
export * from './unsubscribe.ts';
export * from './preferences.ts';
