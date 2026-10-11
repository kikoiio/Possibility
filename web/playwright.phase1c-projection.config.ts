import { defineConfig, devices } from '@playwright/test'

const apiPort = Number(process.env.PHASE1C_API_PORT ?? 18790)
const webPort = Number(process.env.PHASE1C_WEB_PORT ?? 15176)
const root = process.env.PHASE1C_PERSIST_ROOT ?? `${process.cwd()}/.tmp/phase1c`

/** Isolated, single-worker browser configuration for phase 1C projection journeys. */
export default defineConfig({
  testDir: './e2e',
  testMatch: /phase1c-world-projection\.spec\.ts/,
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
  ],
  webServer: [
    {
      command: `TMPDIR=${root}/tmp npm --prefix ../api run dev:s02-e2e -- ${root}/wrangler ${apiPort} standard`,
      url: `http://127.0.0.1:${apiPort}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { TMPDIR: `${root}/tmp`, PHASE1C_PERSIST_ROOT: root },
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
