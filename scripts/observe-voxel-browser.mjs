// Cloud-only browser acceptance with isolated state and a fully synthetic model.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createCampServer } from '../server.mjs';
import { createGeneratedFixture } from '../world-definition.mjs';

if (!process.env.CI) throw Error('Browser observation is cloud-first. Run through the prepared GitHub Actions workflow.');
const output = resolve('.tmp/prototype/voxel-browser');
mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(join(output, 'state-'));
const inputs = [], errors = [], checks = [];
const visual = { syntheticModelCalls: 0, screenshots: [] };
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
const visualCommands = [
  { op: 'fill', from: [-6, 0, -6], to: [6, 0, 6], material: 'grass' },
  { op: 'fill', from: [-3, 1, -3], to: [3, 4, 3], material: 'wood' },
  { op: 'fill', from: [-2, 1, -2], to: [2, 4, 2], material: null },
  { op: 'fill', from: [0, 1, 3], to: [0, 2, 3], material: null },
  { op: 'fill', from: [2, 2, 3], to: [2, 3, 3], material: 'glass' },
  { op: 'fill', from: [3, 2, 0], to: [3, 3, 1], material: 'glass' },
  { op: 'fill', from: [-4, 5, -4], to: [4, 5, 4], material: 'roof' },
  { op: 'fill', from: [-3, 6, -3], to: [3, 6, 3], material: 'roof' },
  { op: 'fill', from: [-2, 7, -2], to: [2, 7, 2], material: 'roof' },
  { op: 'fill', from: [-1, 8, -1], to: [1, 8, 1], material: 'roof' },
  { op: 'fill', from: [5, 1, -4], to: [5, 3, -4], material: 'wood' },
  { op: 'fill', from: [4, 4, -5], to: [6, 5, -3], material: 'leaves' },
];
const visualOptions = {
  stateFile: join(temporary, 'visual', 'state.json'),
  configLoader: options.configLoader,
  fetchImpl: async (_url, init) => {
    visual.syntheticModelCalls++;
    assert.equal(visual.syntheticModelCalls, 1, 'Unexpected visual fixture call');
    const input = JSON.parse(JSON.parse(init.body).input.at(-1).content);
    assert.equal(input.voxel.revision, 0);
    assert.deepEqual(input.voxel.cells, []);
    const value = { reply: '草地上的木屋建好了。', summary: '草地、带窗户和屋顶的木屋，还有一棵树。', ready: false, commands: visualCommands };
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
  },
};
const entryDefinition = createGeneratedFixture();
let entryCalls = 0;
const entryOptions = {
  stateFile: join(temporary, 'entry', 'state.json'),
  configLoader: options.configLoader,
  fetchImpl: async (_url, init) => {
    entryCalls++;
    const input = JSON.parse(JSON.parse(init.body).input.at(-1).content);
    if (input.conversation && !input.step) {
      const userTurns = input.conversation.filter(message => message.role === 'user').length;
      return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
        reply: userTurns < 2 ? '我先把木屋起点搭出来。' : '起点已经清楚，可以生成。',
        summary: '一座带木屋的海边起点。', ready: userTurns >= 2,
        commands: userTurns === 1 ? [
          { op: 'walls', from: [0, 0, 0], to: [4, 3, 4], material: 'wood' },
          { op: 'object', id: 'observatory', name: '观测木屋', kind: 'building', from: [0, 0, 0], to: [4, 3, 4] },
        ] : [],
      }) }] }] });
    }
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(entryDefinition) }] }] });
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

  // A separate service and save keep the visual fixture independent of the
  // fill/replace history while reusing the real page and renderer.
  await new Promise(resolve => server.close(resolve));
  mkdirSync(join(temporary, 'visual'), { recursive: true });
  ({ server } = createCampServer(visualOptions));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#creation-input').disabled);
  assert.deepEqual(cells(await state()), []);
  await send('请在草地上建一座带窗户和屋顶的木屋，旁边种一棵树。');
  const scene = await state();
  assert.equal(scene.revision, 1);
  const blocks = new Map(scene.cells.map(cell => [cell.position.join(','), cell.material]));
  for (const [position, material] of [['-6,0,-6', 'grass'], ['-3,1,-3', 'wood'], ['2,2,3', 'glass'], ['0,8,0', 'roof'], ['5,4,-4', 'leaves']]) {
    assert.equal(blocks.get(position), material, `Unexpected material at ${position}`);
  }
  assert.equal(blocks.has('0,1,3'), false, 'The doorway should be open');
  await page.waitForFunction(revision => window.__observedVoxelRevision === revision, scene.revision);
  assert(!emptyImage.equals(await rendered()), 'The visual fixture must render on the canvas');
  await shot('07-visual-scene');
  visual.screenshots.push('07-visual-scene.png');
  await page.locator('#voxel-scene canvas').screenshot({ path: join(output, '08-visual-canvas.png') });
  visual.screenshots.push('08-visual-canvas.png');
  visual.cells = scene.cells.length;
  assert.equal(visual.syntheticModelCalls, 1);
  assert.equal(inputs.length, 2);
  assert.deepEqual(errors, []);
  checks.push('independent grass and roofed cabin fixture renders for visual review');
  await new Promise(resolve => server.close(resolve));
  mkdirSync(join(temporary, 'entry'), { recursive: true });
  ({ server } = createCampServer(entryOptions));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#creation-input').disabled);
  await send('请先搭一座木屋。');
  await page.locator('#creation-mode').selectOption('discuss');
  await send('把它作为海边的起点。');
  await page.waitForFunction(() => !document.querySelector('#world-generate').disabled);
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/world-generate') && response.request().method() === 'POST'),
    page.locator('#world-generate').click(),
  ]);
  await page.waitForFunction(() => !document.querySelector('#world-draft').hidden && !document.querySelector('#world-accept').disabled);
  const entryDraft = await state();
  assert.equal(entryDraft.cells.length, 64);
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/control') && response.request().postDataJSON()?.type === 'world-accept'),
    page.locator('#world-accept').click(),
  ]);
  await page.waitForFunction(() => document.querySelector('#world-experience').hidden === false && document.querySelector('#scene-host canvas'));
  const entered = await page.request.get('/api/state').then(response => response.json());
  assert.equal(entered.creation.mode, 'world');
  assert.equal(entered.genesis.voxel.cells.length, 64);
  assert.equal(entered.genesis.voxelBindings.anchors[0].id, 'observatory');
  await page.locator('#scene-host canvas').screenshot({ path: join(output, '09-confirmed-world.png') });
  assert.equal(entryCalls, 3);
  checks.push('confirming the origin enters the live world with the same voxel snapshot');
  writeFileSync(join(output, 'report.json'), JSON.stringify({ ok: true, checks, syntheticModelCalls: inputs.length, visual, realModelCalls: 0, errors }, null, 2));
} catch (error) {
  if (page) await shot('failure').catch(() => {});
  writeFileSync(join(output, 'report.json'), JSON.stringify({ ok: false, checks, error: error.message, syntheticModelCalls: inputs.length, visual, realModelCalls: 0, errors }, null, 2));
  throw error;
} finally {
  try {
    if (browser) await browser.close();
  } finally {
    try {
      if (server?.listening) await new Promise(resolve => server.close(resolve));
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}
