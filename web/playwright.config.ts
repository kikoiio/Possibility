import { defineConfig, devices } from '@playwright/test'

const apiPort = Number(process.env.PLAYWRIGHT_API_PORT ?? 18787)
const webPort = Number(process.env.PLAYWRIGHT_WEB_PORT ?? 15173)
const apiDataMode = process.env.PLAYWRIGHT_API_DATA_MODE ?? 'standard'

export default defineConfig({
  testDir: './e2e',
  outputDir: '/tmp/s02-playwright-results',
  fullyParallel: true,
  reporter: 'list',
  retries: 0,
  timeout: 60_000,
  use: { baseURL: `http://127.0.0.1:${webPort}`, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop-chromium', testIgnore: [/.*mobile\.spec\.ts/, /.*scene-compatibility\.spec\.ts/], use: { ...devices['Desktop Chrome'], launchOptions: { args: ['--use-gl=swiftshader', '--no-sandbox'] } } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'], launchOptions: { args: ['--use-gl=swiftshader', '--no-sandbox'] } }, testMatch: /.*mobile\.spec\.ts/, testIgnore: /.*scene-compatibility\.mobile\.spec\.ts/ },
  ],
  webServer: [
    { command: `npm --prefix ../api run dev:s02-e2e -- /tmp/s02-wrangler-e2e-${process.pid} ${apiPort} ${apiDataMode}`, url: `http://127.0.0.1:${apiPort}/api/health`, reuseExistingServer: false, timeout: 120_000 },
    { command: `npm run dev -- --host 127.0.0.1 --port ${webPort}`, url: `http://127.0.0.1:${webPort}`, reuseExistingServer: false, timeout: 60_000, env: { VITE_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` } },
  ],
})
