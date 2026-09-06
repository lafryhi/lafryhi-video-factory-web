import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: process.cwd(),
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        { key: "Cross-Origin-Embedder-Policy", value: "require-corp" }
      ]
    }
  ]
};

export default nextConfig;
