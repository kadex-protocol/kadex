import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  transpilePackages: ["@slab/types", "@slab/sdk"],
  // The repo root, not the home directory — there is a stray lockfile above it.
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
};
