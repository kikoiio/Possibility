import { defineConfig } from '@playwright/test'

/**
 * N2D1 原生 2D 样板独立浏览器验证配置。
 * - 独立 testDir、15174 前端端口、/tmp/native2d-playwright-results 输出、workers:1。
 * - 只管理样板前端；API 连接已有实例（默认 8787，可用 PLAYWRIGHT_NATIVE2D_API_TARGET 覆盖）。
 * - 三个项目互斥匹配：desktop（固定桌面流程）、mobile（390×844 触屏）、live（真实公开读取）。
 */

const webPort = Number(process.env.PLAYWRIGHT_NATIVE2D_WEB_PORT ?? 15174)
const apiTarget = process.env.PLAYWRIGHT_NATIVE2D_API_TARGET ?? 'http://127.0.0.1:8787'

const swiftshaderArgs = ['--use-gl=swiftshader', '--no-sandbox']

export default defineConfig({
  testDir: './native2d-e2e',
  outputDir: '/tmp/native2d-playwright-results',
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
      name: 'native2d-desktop',
      testMatch: [/.*sample\.spec\.ts/, /.*editing\.spec\.ts/, /.*acceptance\.spec\.ts/, /.*lifecycle\.spec\.ts/],
      use: {
        browserName: 'chromium',
        viewport: { width: 1280, height: 720 },
        launchOptions: { args: swiftshaderArgs },
      },
    },
    {
      name: 'native2d-mobile',
      testMatch: /.*sample\.mobile\.spec\.ts/,
      use: {
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        launchOptions: { args: swiftshaderArgs },
      },
    },
    {
      name: 'native2d-live',
      testMatch: /.*readonly-live\.spec\.ts/,
      use: {
        browserName: 'chromium',
        viewport: { width: 1280, height: 720 },
        launchOptions: { args: swiftshaderArgs },
      },
    },
  ],
  webServer: [
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${webPort}`,
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { VITE_API_PROXY_TARGET: apiTarget },
    },
  ],
})
