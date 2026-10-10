import { fileURLToPath } from "node:url";

/** @type {(phase: string) => import('next').NextConfig} */
export default (phase) => ({
  reactStrictMode: true,
  transpilePackages: ["@kadex/types", "@kadex/sdk", "@kadex/oracle", "@kadex/collector-crypt"],
  // The repo root, not the home directory — there is a stray lockfile above it.
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  // In dev each dynamic route forks a process to list its paths, and the fork fails when memory is tight.
  experimental: { workerThreads: phase === "phase-development-server" },
});
