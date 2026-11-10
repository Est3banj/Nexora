import { defineConfig } from "@playwright/test";

const E2E_DB_URL = "postgres://esteban@127.0.0.1:5432/pos_piloto_e2e";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    // D1 gate is explicitly mobile (tasks.md: E2E, 375px)
    viewport: { width: 375, height: 812 },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "sh e2e/start-api.sh",
      url: "http://localhost:3000/api/health",
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        DATABASE_URL: E2E_DB_URL,
        NODE_ENV: "test",
        BETTER_AUTH_URL: "http://localhost:3000",
        BETTER_AUTH_SECRET: "e2e-secret-0123456789abcdef0123456789",
      },
    },
    {
      command: "pnpm --filter @pos/web dev",
      url: "http://localhost:5173",
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        VITE_API_PROXY: "http://localhost:3000",
      },
    },
  ],
});
