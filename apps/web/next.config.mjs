import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // maplibre-gl ships modern ESM/workers; let Next transpile it.
  transpilePackages: ['maplibre-gl'],
  // Pin the workspace root so Next doesn't walk up to a stray lockfile in $HOME.
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
};

export default nextConfig;
