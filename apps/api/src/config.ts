import { configSchemas, loadConfig } from '@flytrace/shared/config';
import { z } from 'zod';

const emptyToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const flightRouteProviderSchema = z.object({
  AERODATABOX_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  AERODATABOX_MARKETPLACE: z.preprocess(
    emptyToUndefined,
    z.enum(['apimarket', 'rapidapi']).default('apimarket'),
  ),
  AERODATABOX_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
});

/** API needs base + database + redis + api + auth + web-push env slices. */
const apiConfigSchema = configSchemas.base
  .merge(configSchemas.database)
  .merge(configSchemas.redis)
  .merge(configSchemas.api)
  .merge(configSchemas.auth)
  .merge(configSchemas.webPush)
  .merge(configSchemas.telegram)
  .merge(configSchemas.email)
  .merge(configSchemas.infra)
  .merge(configSchemas.ws)
  .merge(configSchemas.security)
  .merge(flightRouteProviderSchema);

export type ApiConfig = z.infer<typeof apiConfigSchema>;

export function loadApiConfig(): ApiConfig {
  return loadConfig(apiConfigSchema);
}
