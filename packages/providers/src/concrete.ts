import { ajetProviderFactory } from './ajet/provider.ts';
import { pegasusProviderFactory } from './pegasus/provider.ts';
import { thyProviderFactory } from './thy/provider.ts';
import type { ProviderFactory } from './types.ts';

/**
 * All statically-registered real-airline providers (docs/08 §8.6). Registration
 * ≠ activation: the registry only instantiates keys in its `enabled` set, which
 * the worker derives from the `providers` table / config. Every concrete
 * provider ships **disabled** until its source is compliance-cleared (§8.9).
 */
export function concreteProviderFactories(): ProviderFactory[] {
  return [thyProviderFactory(), pegasusProviderFactory(), ajetProviderFactory()];
}

export * from './thy/provider.ts';
export * from './pegasus/provider.ts';
export * from './ajet/provider.ts';
