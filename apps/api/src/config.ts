import { configSchemas, loadConfig } from '@flytrace/shared/config';
import type { z } from 'zod';

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
  .merge(configSchemas.security);

export type ApiConfig = z.infer<typeof apiConfigSchema>;

export function loadApiConfig(): ApiConfig {
  return loadConfig(apiConfigSchema);
}
