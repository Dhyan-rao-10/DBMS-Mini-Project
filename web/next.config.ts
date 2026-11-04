import type { NextConfig } from "next";

// The repo-wide .env at the root is loaded by src/lib/env.ts (imported by the DB clients).

const nextConfig: NextConfig = {
  // Every page is per-user (session cookie) and reads live data, so pages render on
  // request; caching of expensive numbers is done explicitly in Redis.
  cacheComponents: false,
  // no floating dev badge (it covers the sidebar's sign-out link)
  devIndicators: false,
  // native/driver packages run with Node's require instead of being bundled
  serverExternalPackages: ["neo4j-driver", "ioredis"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
