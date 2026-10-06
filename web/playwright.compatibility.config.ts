import { defineConfig, devices } from '@playwright/test'

/**
 * A1 场景兼容独立浏览器验证配置（W27）。
 * - 冻结 CLI 启动隔离 API：`node api/scripts/start-s02-e2e.mjs <persistTo> <port> scene-compatibility-legacy`，
 *   持久目录 /tmp/possibility-a1-compatibility-e2e，独立端口 8798，独立输出目录。
 * - testMatch 仅本轮 scene-compatibility 桌面/移动文件；默认 1 worker。
 * - reuseExistingServer:false——隔离模式不复用身份不明的既有服务；Playwright 只关闭本配置启动的进程。
 */

const apiPort = Number(process.env.PLAYWRIGHT_COMPAT_API_PORT ?? 8798)
const webPort = Number(process.env.PLAYWRIGHT_COMPAT_WEB_PORT ?? 15198)
const persistTo = process.env.PLAYWRIGHT_COMPAT_PERSIST_TO ?? `/tmp/possibility-a1-compatibility-e2e-${process.pid}`

const swiftshaderArgs = ['--use-gl=swiftshader', '--no-sandbox']

export default defineConfig({
  testDir: './e2e',
  outputDir: '/tmp/possibility-a1-compatibility-playwright-results',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  retries: 0,
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'compatibility-desktop',
      testMatch: /.*scene-compatibility\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], launchOptions: { args: swiftshaderArgs } },
    },
    {
      name: 'compatibility-mobile',
      testMatch: /.*scene-compatibility\.mobile\.spec\.ts/,
      use: { ...devices['Pixel 7'], launchOptions: { args: swiftshaderArgs } },
    },
  ],
  webServer: [
    {
      command: `node ../api/scripts/start-s02-e2e.mjs ${persistTo} ${apiPort} scene-compatibility-legacy`,
      url: `http://127.0.0.1:${apiPort}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${webPort}`,
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { VITE_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` },
    },
  ],
})
