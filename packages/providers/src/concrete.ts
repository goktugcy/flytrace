import { aerodataboxProviderFactory } from './aerodatabox/provider.ts';
import { ajetProviderFactory } from './ajet/provider.ts';
import { baProviderFactory } from './ba/provider.ts';
import { lufthansaProviderFactory } from './lufthansa/provider.ts';
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
  return [
    aerodataboxProviderFactory(),
    thyProviderFactory(),
    pegasusProviderFactory(),
    ajetProviderFactory(),
    lufthansaProviderFactory(),
    baProviderFactory(),
  ];
}

export * from './thy/provider.ts';
export * from './aerodatabox/provider.ts';
export * from './pegasus/provider.ts';
export * from './ajet/provider.ts';
export * from './lufthansa/provider.ts';
export * from './ba/provider.ts';
