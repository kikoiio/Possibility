import { defineConfig, devices } from '@playwright/test'

const apiPort = Number(process.env.PHASE2B_API_PORT ?? 18893)
const webPort = Number(process.env.PHASE2B_WEB_PORT ?? 15177)
const root = process.env.PHASE2B_PERSIST_ROOT ?? `${process.cwd()}/.tmp/phase2b`

/** Isolated, single-worker browser configuration for phase 2B time/status journeys. */
export default defineConfig({
  testDir: './e2e',
  testMatch: /phase2b-time-status\.spec\.ts/,
  outputDir: `${root}/playwright-results`,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  retries: 0,
  timeout: 180_000,
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 }, launchOptions: { args: ['--use-gl=swiftshader', '--no-sandbox'] } } },
  ],
  webServer: [
    {
      command: `TMPDIR=${root}/tmp npm --prefix ../api run dev:s02-e2e -- ${root}/wrangler ${apiPort} standard`,
      url: `http://127.0.0.1:${apiPort}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { TMPDIR: `${root}/tmp`, PHASE2B_PERSIST_ROOT: root },
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
