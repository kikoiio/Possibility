import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const output = `${root}/.tmp/geometry-lab`;
await fs.mkdir(`${output}/browser-profile`, { recursive: true });
await fs.mkdir(`${output}/tmp`, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  userDataDir: `${output}/browser-profile`,
  env: { ...process.env, TMPDIR: `${output}/tmp`, WAYLAND_DISPLAY: '' },
  args: [
    '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ozone-platform=x11', '--window-size=1440,1000',
  ],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__geometryLab?.worlds.length === 2, { timeout: 60000 }).catch(async error => {
    console.error('Page errors:', errors);
    console.error(await page.evaluate(() => document.querySelector('#loading')?.textContent));
    throw error;
  });
  const screenshot = async name => {
    await new Promise(resolve => setTimeout(resolve, 700));
    await page.screenshot({ path: `${output}/${name}.png` });
  };
  await screenshot('solid-refined');
  await page.click('[data-mode="voxel"]');
  await screenshot('voxel');
  await page.click('[data-mode="split"]');
  await screenshot('split');
  await page.click('[data-mode="solid"]');
  await page.click('[data-view="interior"]');
  await screenshot('interior');
  await page.evaluate(() => {
    window.__beforeEdit = window.__geometryLab.worlds.map(world => Object.fromEntries(Object.entries(world.userData.parts).map(([id, part]) => {
      const resources = [];
      part.traverse(node => { if (node.isMesh) resources.push([node.geometry, node.material]); });
      return [id, { part, resources, hash: part.userData.recipeHash }];
    })));
  });
  await page.click('#edit-porch');
  await page.click('[data-view="island"]');
  await screenshot('edited');
  const result = await page.evaluate(() => ({
    state: window.__geometryLab.state,
    render: window.__geometryLab.renderer.info.render,
    worlds: window.__geometryLab.worlds.map(world => window.__geometryLab.collectStats(world)),
    bodyWidth: document.body.scrollWidth,
    viewportWidth: innerWidth,
    incremental: window.__geometryLab.worlds.map((world, i) => ({
      rebuiltParts: world.userData.rebuiltParts,
      stable: ['terrain', 'library', 'interior', 'nature'].every(id => {
        const before = window.__beforeEdit[i][id], part = world.userData.parts[id], resources = [];
        part.traverse(node => { if (node.isMesh) resources.push([node.geometry, node.material]); });
        return part === before.part && part.userData.recipeHash === before.hash && resources.length === before.resources.length && resources.every((r, j) => r[0] === before.resources[j][0] && r[1] === before.resources[j][1]);
      }),
    })),
  }));
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.click('[data-mode="voxel"]');
  await screenshot('mobile');
  result.mobile = await page.evaluate(() => ({ bodyWidth: document.body.scrollWidth, viewportWidth: innerWidth }));
  // Drive document application without model/network calls, including the rejected-proposal path.
  result.documentEdit = await page.evaluate(async () => {
    const lab = window.__geometryLab;
    const next = structuredClone(lab.state.scene);
    next.objects.find(o => o.kind === 'porch').bounds.width += 0.2;
    lab.applyDocument(next);
    const incremental = lab.worlds.map(w => w.userData.rebuiltParts);
    const before = lab.state.scene;
    const invalid = structuredClone(before);
    invalid.objects[0].kind = 'unknown';
    let rejected = false;
    try { lab.applyDocument(invalid); } catch { rejected = lab.state.scene === before; }
    const { createUnfamiliarScene } = await import('/src/scene-fixtures.js');
    lab.applyDocument(createUnfamiliarScene());
    return { incremental, rejected, sceneId: lab.state.scene.id, worldCount: lab.worlds.length };
  });
  result.errors = errors;
  await fs.writeFile(`${output}/observation.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  assert.deepEqual(errors, [], 'browser errors');
  assert.equal(result.bodyWidth, result.viewportWidth);
  assert.equal(result.mobile.bodyWidth, result.mobile.viewportWidth);
  for (const edit of result.incremental) {
    assert.deepEqual(edit.rebuiltParts, ['porch', 'bridge']);
    assert.equal(edit.stable, true);
  }
  assert.deepEqual(result.documentEdit.incremental, [['porch'], ['porch']]);
  assert.equal(result.documentEdit.rejected, true);
  assert.equal(result.documentEdit.worldCount, 2);
} finally {
  await browser.close();
}
