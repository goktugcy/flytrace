/**
 * Browser-safe security helpers.
 *
 * This entry point is imported by the Next.js edge middleware, so it must stay
 * free of Node built-ins. The token primitives live behind
 * `@flytrace/shared/security/tokens` (and the root barrel) because they depend
 * on `node:crypto`, which the edge bundler cannot resolve.
 */
export * from './csp.ts';
