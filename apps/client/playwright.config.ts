import { defineConfig, devices } from '@playwright/test';
import { hasAuthCredentials, resolvedE2EConfig } from './e2e/support/e2e-config';

const { baseURL, backendURL, useBuild } = resolvedE2EConfig;

// E2E_USE_BUILD=true (CI) runs the built backend against a fresh database and
// serves the production client build; build both first. Otherwise the dev
// servers start, or already running ones are reused.
const webServer = useBuild
  ? [
      {
        command: 'node e2e/support/start-backend.mjs',
        url: backendURL,
        timeout: 120 * 1000,
        reuseExistingServer: false,
      },
      {
        command: 'node e2e/support/serve-dist.mjs',
        url: baseURL,
        timeout: 30 * 1000,
        reuseExistingServer: false,
      },
    ]
  : [
      {
        command: 'pnpm run dev',
        cwd: '../backend',
        url: backendURL,
        timeout: 180 * 1000,
        reuseExistingServer: !process.env['CI'],
      },
      {
        command: 'pnpm exec ng serve --host 127.0.0.1 --port 4200',
        cwd: '.',
        url: baseURL,
        timeout: 180 * 1000,
        reuseExistingServer: !process.env['CI'],
      },
    ];

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: process.env['CI'] ? 1 : undefined,
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : 'html',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  webServer,
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: hasAuthCredentials ? 'playwright/.auth/user.json' : undefined,
      },
      dependencies: ['setup'],
      testIgnore: /auth\.setup\.ts/,
    },
  ],
});
