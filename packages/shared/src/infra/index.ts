/**
 * Cross-cutting infrastructure abstractions shared by every app/worker: the
 * env-switchable adapter convention (provider-kit), secret access, and tracing.
 * Each is interface-first with an always-present local fallback so the whole
 * system boots with zero external services and swaps to production adapters via
 * env only.
 */
export * from './provider-kit.ts';
export * from './secret.ts';
export * from './tracing.ts';
