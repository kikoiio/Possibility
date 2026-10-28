// Cloud-only browser acceptance with isolated state and a fully synthetic model.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createCampServer } from '../server.mjs';

if (!process.env.CI) throw Error('Browser observation is cloud-first. Run through the prepared GitHub Actions workflow.');
const output = resolve('.tmp/prototype/voxel-browser');
mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(join(output, 'state-'));
const inputs = [], errors = [], checks = [];
const options = {
  stateFile: join(temporary, 'state.json'),
  configLoader: () => ({ llm: { baseUrl: 'https://fixture.invalid/v1', model: 'synthetic-voxel-browser', apiKey: 'synthetic-only' } }),
  fetchImpl: async (_url, init) => {
    const input = JSON.parse(JSON.parse(init.body).input.at(-1).content);
    inputs.push(input);
    const commands = inputs.length === 1
      ? [{ op: 'fill', from: [0, 0, 0], to: [2, 1, 0], material: 'wood' }]
      : inputs.length === 2
        ? [{ op: 'replace', from: [1, 0, 0], to: [1, 1, 0], match: 'wood', material: 'glass' }]
        : assert.fail('Unexpected synthetic model call');
    const value = { reply: inputs.length === 1 ? '已建起木墙。' : '已把中间两块换成玻璃。', summary: '一面带玻璃的墙。', ready: false, commands };
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
  },
};
let server, browser, page;
const shot = name => page.screenshot({ path: join(output, `${name}.png`), fullPage: true });
const cells = voxel => voxel.cells.map(({ position, material }) => `${position.join(',')}:${material}`).sort();
const wood = ['0,0,0:wood', '0,1,0:wood', '1,0,0:wood', '1,1,0:wood', '2,0,0:wood', '2,1,0:wood'].sort();
const glass = ['0,0,0:wood', '0,1,0:wood', '1,0,0:glass', '1,1,0:glass', '2,0,0:wood', '2,1,0:wood'].sort();
const state = async () => {
  const response = await page.request.get('/api/state');
  assert.equal(response.status(), 200);
  return (await response.json()).creation.voxel;
};
const rendered = async () => {
  const canvas = page.locator('#voxel-scene canvas');
  await canvas.waitFor({ state: 'visible' });
  assert(await canvas.evaluate(el => el.width > 1 && el.height > 1));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return canvas.screenshot();
};
const send = async message => {
  await page.locator('#creation-input').fill(message);
  await page.locator('#creation-send').click();
  await page.waitForFunction(() => !document.querySelector('#creation-input').disabled && !document.querySelector('#creation-input').value);
};
const control = async type => {
  const [response] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/control') && response.request().method() === 'POST' && response.request().postDataJSON()?.type === `voxel-${type}`),
    page.locator(`#voxel-${type}`).click(),
  ]);
  assert.equal(response.status(), 200);
  const result = await response.json();
  assert.equal(result.ok, true, result.message);
  const voxel = result.state.creation.voxel;
  assert.equal((await state()).revision, voxel.revision);
  await page.waitForFunction(({ revision, canUndo, canRedo }) =>
    window.__observedVoxelRevision === revision &&
    !document.querySelector('#creation-input').disabled &&
    document.querySelector('#voxel-undo').disabled === !canUndo &&
    document.querySelector('#voxel-redo').disabled === !canRedo, voxel);
  return voxel;
};
try {
  ({ server } = createCampServer(options));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--disable-dev-shm-usage'] });
  page = await browser.newPage({ baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => errors.push(error.message));
  // Record revisions only after the real renderer accepts an update. The app
  // does not otherwise expose its current voxel revision in the DOM.
  await page.route('**/voxel-scene.js', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const declaration = 'export async function createVoxelScene(host, initialWorld)';
    assert(source.includes(declaration), 'Voxel renderer entry point changed');
    const wrapped = source.replace(declaration, 'async function createVoxelSceneImpl(host, initialWorld)') + `
export async function createVoxelScene(host, initialWorld) {
  const scene = await createVoxelSceneImpl(host, initialWorld);
  window.__observedVoxelRevision = initialWorld.revision;
  const update = scene.update;
  scene.update = world => { update(world); window.__observedVoxelRevision = world.revision; };
  return scene;
}
`;
    await route.fulfill({ response, body: wrapped });
  });
  await page.goto('/');
  await page.waitForFunction(() => !document.querySelector('#creation-input').disabled);
  assert.deepEqual(cells(await state()), []);
  const emptyImage = await rendered();
  await shot('01-empty');

  await send('请建一面三格宽、两格高的木墙。');
  const first = await state();
  assert.deepEqual(cells(first), wood);
  assert.deepEqual(cells(inputs[0].voxel), []);
  const woodImage = await rendered();
  assert(!emptyImage.equals(woodImage), 'The canvas must change when blocks are built');
  await shot('02-fill');
  checks.push('fill builds six wood cells and changes the canvas');

  await send('把中间两块木头换成玻璃。');
  const second = await state();
  assert.deepEqual(cells(second), glass);
  assert.equal(inputs[1].voxel.revision, first.revision);
  assert.deepEqual(cells(inputs[1].voxel), wood);
  const glassImage = await rendered();
  assert(!woodImage.equals(glassImage), 'The canvas must change when materials are replaced');
  await shot('03-replace');
  checks.push('replace sees the previous world and changes only matching cells');

  const undone = await control('undo');
  assert.deepEqual(cells(undone), wood);
  assert.deepEqual(cells(await state()), wood);
  const undoImage = await rendered();
  assert(!glassImage.equals(undoImage), 'Undo must update the canvas');
  await shot('04-undo');
  const redone = await control('redo');
  assert.deepEqual(cells(redone), glass);
  assert.deepEqual(cells(await state()), glass);
  const redoImage = await rendered();
  assert(!undoImage.equals(redoImage), 'Redo must update the canvas');
  checks.push('undo and redo update state and canvas');

  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#creation-input').disabled);
  assert.deepEqual(cells(await state()), glass);
  assert(!emptyImage.equals(await rendered()), 'Refresh must render the restored blocks');
  await shot('05-refresh');
  assert.equal(inputs.length, 2);
  checks.push('refresh restores the edited scene without another model call');

  // Restart the service as well, so restoration exercises the isolated files.
  await new Promise(resolve => server.close(resolve));
  ({ server } = createCampServer(options));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#creation-input').disabled);
  assert.deepEqual(cells(await state()), glass);
  assert(!emptyImage.equals(await rendered()), 'Restart must render the restored blocks');
  await shot('06-restart');
  assert.equal(inputs.length, 2);
  assert.deepEqual(errors, []);
  checks.push('service restart restores the isolated saved scene');
  writeFileSync(join(output, 'report.json'), JSON.stringify({ ok: true, checks, syntheticModelCalls: inputs.length, realModelCalls: 0, errors }, null, 2));
} catch (error) {
  if (page) await shot('failure').catch(() => {});
  writeFileSync(join(output, 'report.json'), JSON.stringify({ ok: false, checks, error: error.message, syntheticModelCalls: inputs.length, realModelCalls: 0, errors }, null, 2));
  throw error;
} finally {
  if (browser) await browser.close();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  rmSync(temporary, { recursive: true, force: true });
}
