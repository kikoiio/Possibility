// 村庄预览截图：一个无头 Chrome，逐个打开 preview.html?doc=…，双后端并排截图。
// 截图写入 ../../.tmp/geometry-lab/preview/<id>.png。不调用模型。
import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['v1-quayside', 'v2-hilltop', 'v3-scattered', 'v4-compact'];
const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const output = `${root}/.tmp/geometry-lab/preview`;
await fs.mkdir(`${output}`, { recursive: true });
await fs.mkdir(`${root}/.tmp/geometry-lab/tmp`, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  userDataDir: `${root}/.tmp/geometry-lab/browser-profile`,
  env: { ...process.env, TMPDIR: `${root}/.tmp/geometry-lab/tmp`, WAYLAND_DISPLAY: '' },
  args: [
    '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ozone-platform=x11', '--window-size=1440,810',
  ],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 810, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400 && !response.url().includes('favicon')) console.log(`HTTP ${response.status()} ${response.url()}`); });
  for (const id of ids) {
    const file = id.includes('/') ? (id.endsWith('.json') ? id : `${id}.generate.json`) : `/generated/glm-session/${id.endsWith('.json') ? id : `${id}.generate.json`}`;
    await page.goto(`http://127.0.0.1:5173/preview.html?doc=${file}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => window.__preview?.ready === true, { timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 900));
    await page.screenshot({ path: `${output}/${id.split('/').pop().replace('.json', '')}.png` });
    console.log(`已截图 ${id}:`, JSON.stringify(await page.evaluate(() => window.__preview)));
  }
  if (errors.length) throw new Error(`页面错误：${errors.join('；')}`);
  console.log('无页面错误');
} finally {
  await browser.close();
}
