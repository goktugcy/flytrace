import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // maplibre-gl ships modern ESM/workers; the shared package is TS source with
  // .ts-extension imports — let Next transpile both.
  transpilePackages: ['maplibre-gl', '@flytrace/shared'],
  // Pin the workspace root so Next doesn't walk up to a stray lockfile in $HOME.
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
};

export default nextConfig;
