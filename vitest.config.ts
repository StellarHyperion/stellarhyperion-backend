import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Integration tests share one Postgres and each one owns a schema, so they can run in
    // parallel files. Unit tests touch nothing outside the process.
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    reporters: ["default"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/main.ts"],
    },
  },
});
