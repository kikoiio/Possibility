import { defineConfig, devices } from '@playwright/test'

const apiPort = Number(process.env.PHASE1B_API_PORT ?? 18789)
const webPort = Number(process.env.PHASE1B_WEB_PORT ?? 15175)
const root = process.env.PHASE1B_PERSIST_ROOT ?? `${process.cwd()}/.tmp/phase1b`

/** Isolated, single-worker browser configuration for phase 1B claim journeys. */
export default defineConfig({
  testDir: './e2e',
  testMatch: /phase1b-guest-save\.spec\.ts/,
  outputDir: `${root}/playwright-results`,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  retries: 0,
  timeout: 120_000,
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 }, launchOptions: { args: ['--use-gl=swiftshader', '--no-sandbox'] } } },
    { name: 'compact', use: { ...devices['Desktop Chrome'], viewport: { width: 485, height: 724 }, launchOptions: { args: ['--use-gl=swiftshader', '--no-sandbox'] } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, launchOptions: { args: ['--use-gl=swiftshader', '--no-sandbox'] } } },
  ],
  webServer: [
    {
      command: `TMPDIR=${root}/tmp npm --prefix ../api run dev:s02-e2e -- ${root}/wrangler ${apiPort} standard`,
      url: `http://127.0.0.1:${apiPort}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { TMPDIR: `${root}/tmp`, PHASE1B_PERSIST_ROOT: root },
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${webPort}`,
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { VITE_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`, TMPDIR: `${root}/tmp` },
    },
  ],
})
// End of the isolated browser configuration.
