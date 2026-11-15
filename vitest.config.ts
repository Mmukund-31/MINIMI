import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 20_000,
    env: { SEED_DEMO_DATA: "false", LOG_LEVEL: "silent" },
  },
});
