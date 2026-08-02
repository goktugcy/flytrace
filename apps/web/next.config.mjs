import { fileURLToPath } from 'node:url';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emit .next/standalone: a self-contained server plus only the node_modules
  // it actually traced. The production image copies that instead of the whole
  // workspace, which is what keeps the runtime layer small and free of dev
  // dependencies and source files.
  output: 'standalone',
  // Never leak the framework/version in response headers.
  poweredByHeader: false,
  // maplibre-gl ships modern ESM/workers; the shared package is TS source with
  // .ts-extension imports — let Next transpile both.
  transpilePackages: ['maplibre-gl', '@flytrace/shared'],
  // Pin the workspace root so Next doesn't walk up to a stray lockfile in $HOME.
  outputFileTracingRoot: fileURLToPath(new URL('../..', import.meta.url)),
};

export default nextConfig;
