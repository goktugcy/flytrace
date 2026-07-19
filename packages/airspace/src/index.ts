/**
 * @flytrace/airspace — airspace geometry + provider domain, shared by the
 * tracker (EnteredAirspace detection) and the API (GET /airspace/current).
 * Lives in its own package so both apps import it cleanly instead of reaching
 * across app boundaries.
 */
export * from './types.ts';
export * from './point-in-polygon.ts';
export * from './spatial-index.ts';
export * from './cache.ts';
export * from './airspace-service.ts';
export * from './importer.ts';
export * from './events.ts';
export * from './providers/index.ts';
