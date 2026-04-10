import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "*.test.js",
  timeout: 40_000,
  expect: {
    timeout: 6_000,
  },
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
      },
    },
  ],
});
