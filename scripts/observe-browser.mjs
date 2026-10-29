// Cloud-only browser observation. The injected model is explicitly synthetic;
// this validates the real page, HTTP/SSE and commit path without any API key.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createCampServer } from '../server.mjs';
import { createGeneratedFixture } from '../world-definition.mjs';

if (!process.env.CI) throw Error('Browser observation is cloud-first. Run through the prepared GitHub Actions workflow.');
const output = resolve('.tmp/prototype/browser'); mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(join(output, 'state-'));
let discussions = 0, generations = 0, calls = 0;
const story = '合成故事：海岛观测站靠海风蓄能。守灯人准备在傍晚记录星图。';
const materialRequests = [];
const { server, experience } = createCampServer({ stateFile: join(temporary, 'state.json'),
  configLoader: () => ({ llm: { baseUrl: 'https://fixture.invalid/v1', model: 'synthetic-browser-fixture', apiKey: 'not-a-credential' } }),
  fetchImpl: async (_url, init) => {
    calls++;
    const input = JSON.parse(JSON.parse(init.body).input.at(-1).content);
    if (input.sourceMaterial) materialRequests.push({ characters: input.sourceMaterial.characters, context: input.sourceContext?.text || '' });
    await delay(input.observation ? 450 : 120, undefined, { signal: init.signal });
    let value;
    if (input.previousSummary !== undefined) {
      discussions++;
      value = { reply: discussions === 1 ? '先从海岛上的哪一处开始？你最想看见什么变化？' : '先做观测台、码头和档案室。海风补充电量，观星员消耗电量记录星图。可以生成这一小片，也可以继续改。', summary: '已讨论：海岛观测站的三个地点，两位居民；海风蓄能，记录星图消耗电量。', ready: discussions > 1 };
    } else if (input.observation) {
      const o = input.observation;
      value = { observationMinute: o.worldMinute, action: o.actorId === 'mira' ? { type: 'perform', actionId: 'record-chart' } : { type: 'rest' }, reason: '根据当前观察选择可执行的行动。', memory: '我记住了这次尝试和实际结果。' };
    } else {
      generations++; value = createGeneratedFixture();
      if (generations > 1) { value.world.title = '修订后的雾海星图站'; value.scene.title = value.world.title; }
    }
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
  } });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=swiftshader', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
const errors = [], checks = [];
page.on('pageerror', error => errors.push(error.message));
const shot = name => page.screenshot({ path: join(output, name + '.png'), fullPage: true });
const send = async text => { await page.locator('#creation-mode').selectOption('discuss'); await page.locator('#creation-input').fill(text); await page.locator('#creation-send').click(); await page.waitForFunction(() => !document.querySelector('#creation-input').disabled); };
try {
  await page.goto(address); await page.waitForFunction(() => !document.querySelector('#creation-input').disabled);
  await shot('01-conversation-start');
  await page.locator('#source-input').setInputFiles({ name: '故事.txt', mimeType: 'text/plain', buffer: Buffer.from(story) });
  await page.waitForFunction(() => document.querySelector('#source-status').textContent.includes('故事.txt'));
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  await shot('01-entry-mobile');
  await page.setViewportSize({ width: 1440, height: 960 });
  await send('我想从一座靠海风蓄能的海岛观测站开始。');
  assert.equal(await page.locator('#world-generate').isVisible(), true);
  assert.equal(experience.state().world, null); checks.push('first message clarifies instead of fabricating a world');
  await send('先做三处地点和两位居民，记录星图消耗电量，海风每分钟补充电量。');
  await page.locator('#world-generate').click(); await page.locator('#world-accept').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#world-accept').disabled);
  await page.locator('#world-draft-scene canvas, #world-draft-scene svg').waitFor();
  assert(materialRequests.length >= 3 && materialRequests.every(value => value.characters === story.length && value.context.includes(story)));
  checks.push('uploaded text reaches discussion and generation');
  await shot('02-discussion-and-draft');
  await send('起点保留，标题改成修订后的雾海星图站。');
  assert.equal(await page.locator('#world-accept').isDisabled(), true); checks.push('feedback invalidates prior confirmation');
  await page.locator('#world-generate').click();
  await page.waitForFunction(() => !document.querySelector('#world-accept').disabled);
  await page.locator('#world-accept').click();
  await page.locator('#world-experience').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#actor-step').disabled);
  assert.equal(experience.state().worldMinute, 0); checks.push('only confirmation establishes a paused origin');
  await page.locator('#actor-step').click();
  await page.locator('#model-progress').waitFor({ state: 'visible' });
  assert.equal(experience.state().worldMinute, 0); checks.push('pending decision is not displayed as a committed fact');
  await page.waitForFunction(() => document.querySelector('#world-time').textContent.includes('1'));
  await page.waitForFunction(() => document.querySelector('#activity-log').textContent.includes('记录星图'));
  assert.match(await page.locator('#activity-log').innerText(), /5 → 2/);
  const count = await page.locator('#activity-log > li').count();
  const callCount = calls;
  await page.reload(); await page.waitForFunction(() => !document.querySelector('#actor-step').disabled);
  assert.equal(await page.locator('#activity-log > li').count(), count); assert.equal(calls, callCount);
  checks.push('SSE reconnect restores committed activity without duplicate events or model calls');
  await page.locator('#play-pause').click();
  await page.waitForFunction(() => Number(document.querySelector('#world-time').textContent.match(/\d+/)?.[0]) >= 3);
  await page.locator('#play-pause').click();
  await page.waitForFunction(() => document.querySelector('#play-pause').textContent === '播放');
  await page.waitForFunction(() => document.querySelector('#model-progress').hidden);
  assert.equal(experience.state().paused, true); checks.push('play streams further actions; pause stops new turns');
  await shot('03-live-world-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  await shot('04-live-world-mobile'); checks.push('mobile has no horizontal overflow');
  assert.deepEqual(errors, []);
  writeFileSync(join(output, 'report.json'), JSON.stringify({ ok: true, checks, syntheticModelCalls: calls, realModelCalls: 0, errors, finalMinute: experience.state().worldMinute }, null, 2));
} catch (error) {
  await shot('failure').catch(() => {});
  writeFileSync(join(output, 'report.json'), JSON.stringify({ ok: false, checks, error: error.message, errors, syntheticModelCalls: calls, realModelCalls: 0 }, null, 2));
  throw error;
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve)); rmSync(temporary, { recursive: true, force: true });
}
