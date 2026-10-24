import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createPrototype } from './server.js';

const here = dirname(fileURLToPath(import.meta.url));
const artifacts = join(here, 'artifacts');
mkdirSync(artifacts, { recursive: true });
const require = createRequire(join(process.env.WISPIVA_BROWSER_TOOLS || resolve(here, '../../.tmp/browser'), 'package.json'));
const { chromium } = require('playwright-core');
const app = createPrototype({ port: 0, dataDir: mkdtempSync(join(artifacts, 'ui-data-')) });
const port = await app.start();
const url = `http://127.0.0.1:${port}`;
let browser;
const errors = [];
const results = [];
try {
  browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome',
    headless: true,
    args: ['--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ozone-platform=x11'],
    env: { ...process.env, WAYLAND_DISPLAY: '' },
  });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.getByRole('heading', { name: '临江 · 戏台浮出水面的那一天', exact: true }).waitFor();
  assert.equal(await page.locator('#stage-2d canvas').count(), 1);
  const webgl = await page.locator('#stage-3d canvas').evaluate(canvas => {
    const gl = canvas.getContext('webgl');
    return !!gl && !gl.isContextLost() && gl.getError() === gl.NO_ERROR;
  });
  assert(webgl, 'WebGL 必须真正初始化');
  await page.getByRole('button', { name: '2D 俯视', exact: true }).click();
  await page.screenshot({ path: join(artifacts, 'desktop-2d.png'), fullPage: true });
  await page.getByRole('button', { name: '3D 空间', exact: true }).click();
  const box = await page.locator('#stage-3d canvas').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 20, { steps: 10 });
  await page.mouse.up();
  await page.mouse.wheel(0, -50);
  await page.screenshot({ path: join(artifacts, 'desktop-3d.png'), fullPage: true });
  await page.getByRole('button', { name: '并排对照', exact: true }).click();
  await page.locator('#speed').fill('1440');
  await page.locator('#speed').press('Tab');
  await page.locator('#pause').click();
  await page.waitForFunction(() => document.querySelectorAll('.journal-entry').length >= 2);
  await page.screenshot({ path: join(artifacts, 'desktop-split-running.png'), fullPage: true });
  await page.locator('#what-if').click();
  await page.locator('#editor').waitFor({ state: 'visible' });
  await page.locator('#edit-instruction').fill('如果白薇愿意保护戏台，陆则也选择帮助老周');
  await page.locator('#ask-llm').click();
  await page.waitForFunction(() => document.getElementById('edit-explanation').textContent.includes('演示模式'));
  const anchor = await page.locator('#draft-anchor').textContent();
  const base = JSON.parse(await page.locator('#world-json').inputValue());
  base.entities.lu.goal = '帮助老周公开全部真相';
  base.rules.push('白薇主动保护戏台，不让测绘队封闭它');
  base.entities.bai.goal = '保护镇民和戏台';
  await page.locator('#draft-name').fill('如果真相被说出来');
  await page.locator('.advanced summary').click();
  await page.locator('#world-json').fill(JSON.stringify(base, null, 2));
  await page.locator('#apply-json').click();
  await page.screenshot({ path: join(artifacts, 'editor.png'), fullPage: true });
  await page.locator('#confirm-edit').click();
  await page.locator('#editor').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelectorAll('.line-button').length === 2);
  const state = await page.evaluate(async () => (await fetch('/api/state')).json());
  const child = state.lines.find(l => l.name === '如果真相被说出来');
  assert(child && child.world.entities.lu.goal === '帮助老周公开全部真相');
  assert(child.world.entities.bai.goal === '保护镇民和戏台');
  results.push({ case: 'fixed-base-editor-ui', anchor, childTime: child.forkTime, changedFields: child.log.find(e => e.kind === 'edit').changes });
  await page.locator('#open-multiverse').click();
  await page.screenshot({ path: join(artifacts, 'multiverse.png'), fullPage: true });
  assert.equal(await page.locator('.universe-node').count(), 2);
  await page.getByRole('button', { name: '关闭多元宇宙', exact: true }).click();
  await page.locator('#pause').click();
  const before = await page.evaluate(async () => {
    const s = await (await fetch('/api/state')).json();
    return s.lines.find(l => l.name === '如果真相被说出来').worldTime;
  });
  await page.waitForTimeout(1200);
  const after = await page.evaluate(async () => {
    const s = await (await fetch('/api/state')).json();
    return s.lines.find(l => l.name === '如果真相被说出来').worldTime;
  });
  assert.equal(after, before);
  await page.getByRole('button', { name: '长期记忆', exact: true }).click();
  await page.screenshot({ path: join(artifacts, 'memory.png'), fullPage: true });
  const secretLeak = await page.evaluate(async () => {
    const s = await (await fetch('/api/state')).json();
    return JSON.stringify(s).includes('"apiKey"');
  });
  assert.equal(secretLeak, false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '事件日志', exact: true }).click();
  await page.locator('#toast').waitFor({ state: 'hidden' });
  await page.screenshot({ path: join(artifacts, 'mobile.png'), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2);
  assert.equal(overflow, false, '手机页面不能横向溢出');
  assert.deepEqual(errors, []);
  results.push({ case: 'dual-renderer-and-ui', webgl, views: ['2d', '3d', 'split'], mobileHorizontalOverflow: overflow, runtimeErrors: errors });
  writeFileSync(join(artifacts, 'browser-observations.json'), JSON.stringify({ results, realLlm: false }, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  if (browser) await browser.close();
  await app.close();
}
