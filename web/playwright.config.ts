import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  outputDir: '/tmp/s02-playwright-results',
  fullyParallel: true,
  reporter: 'list',
  retries: 0,
  use: { baseURL: 'http://127.0.0.1:5173', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop-chromium', testIgnore: /.*mobile\.spec\.ts/, use: { ...devices['Desktop Chrome'], launchOptions: { args: ['--use-gl=swiftshader', '--no-sandbox'] } } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'], launchOptions: { args: ['--use-gl=swiftshader', '--no-sandbox'] } }, testMatch: /.*mobile\.spec\.ts/ },
  ],
  webServer: { command: 'npm run dev -- --host 127.0.0.1', url: 'http://127.0.0.1:5173', reuseExistingServer: !process.env.CI, timeout: 30_000 },
})
