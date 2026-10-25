// 生成对照实验：同一模型、同样预算，对一组陌生场景意图生成语义 SceneDocument，
// 比较两个确定性后端（solid / voxel）的编译成功率与局部修订质量。
// 不需要浏览器或 GPU：编译与空间探针全部是 three.js 的 CPU 数学。
//
// 用法：
//   node generate-experiment.mjs --mock                 # mock 模型跑通整条管道
//   node generate-experiment.mjs --max-calls=12         # 真实模型（需 settings.json 或环境变量）
//
// 结果写入 ../../.tmp/geometry-lab/generate-experiment/{report.json,report.md}。

import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as THREE from 'three';
import { validateSceneDocument, validateSpatialLayout, formatDiagnostic, libraryScene, villageScene } from './src/scene-document.js';
import { compileScene, prepareSceneUpdate, disposeWorld, SceneCompileError } from './src/scene-compiler.js';
import { intents, defaultIntentIds, villageIntents, villageIntentIds } from './experiment-intents.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.WISPIVA_LAB_DATA || join(root, '../../.data/geometry-lab');
const outDir = process.env.WISPIVA_LAB_OUT || join(root, '../../.tmp/geometry-lab/generate-experiment');
const auditFile = join(dataDir, 'experiment-audit.jsonl');
await mkdir(dataDir, { recursive: true, mode: 0o700 });
await mkdir(outDir, { recursive: true });

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = args.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const [, value] = hit.split('=');
  return value === undefined ? true : value;
};
const mock = flag('mock', false);
const maxCalls = Number(flag('max-calls', 12));
const wanted = flag('intents', null);
const intentSet = flag('set', 'worldline');
const allIntents = intentSet === 'village' ? villageIntents : intents;
const defaultIds = intentSet === 'village' ? villageIntentIds : defaultIntentIds;
const intentIds = (wanted ? String(wanted).split(',') : defaultIds).filter(Boolean);

const materialNames = ['grass','earth','stone','stoneDark','plaster','wood','woodLight','roof','roofLight','glass','water','waterLight','leaf','leafLight','reed','cream','terracotta','bookRed','bookBlue','bookGold','dark'];
const materials = Object.fromEntries(materialNames.map(name => [name, new THREE.MeshStandardMaterial()]));
const options = { materials, details: true, edited: false, cutaway: false };
const BACKENDS = ['solid', 'voxel'];
const ALL_PARTS = ['terrain', 'library', 'interior', 'porch', 'bridge', 'nature'];

const GEN_SYSTEM = `你负责根据文字意图创建 Wispiva 的 3D 场景语义文档（SceneDocument）。只返回一个完整 JSON 对象，不要 markdown。
坐标使用米制右手系、Y 向上，schemaVersion=1，所有数值有限、尺寸为正。
实验场景子集：恰好一个 water、一个或多个 island、恰好一个 library、一个 porch、一个 bridge、任意多棵 tree（kind=water/island/library/porch/bridge/tree）。library 只支持 front 入口与 gable 屋顶。字段结构参考 example。
生成时必须满足这些硬约束，做不到就调整尺寸，不要虚构新类型：
- library/porch 的 bounds.width/depth 在 0.5 到 30 之间；library.wallHeight 2 到 15；floor ≥ 0。
- 门廊必须覆盖 library 的 front 入口：门中心相对门廊横向偏移 + 入口宽/2 ≤ 门廊宽/2，纵向在门廊深度内，两者地板高差 ≤ 0.3。
- 入口净空：entrance.width ≥ max(0.9, voxelUnit*3)，height ≥ 1.8，且宽 ≤ library.width−0.8、高 ≤ wallHeight−0.2。
- 室内沿墙书架与桌椅周围需保证 ≥0.9m 走道：宽度方向留白 ≥1.8m、深度方向留白 ≥1.8m（越小的屋子越要注意）。
- 建筑与门廊的四角（含出檐 0.65/0.2m）必须落在某个 island 内；岛屿半径 1 到 40，irregularity 0 到 0.2。
- 树冠中心到建筑外墙 ≥ 3.2*scale；树到所在岛边界 ≥ 3.2*scale+voxelUnit；树与桥中心线的水平距离 > bridge.width/2 + 3.2*scale。
- bridge 两端 point 必须落在各自 island 内（含 bridge.width/2+voxelUnit/2 的余量），y 与该岛 elevation 差 ≤0.5；路径长 ≤100；相邻段坡度 ≤0.8。
- 每个 island 满足 |中心−water中心| + radius*1.3 ≤ water.size/2。`;

const VILLAGE_GEN_SYSTEM = `${GEN_SYSTEM}
本次是村庄级场景：除 library/porch/bridge/tree 外还支持 kind=house（民居，与 library 同构：bounds/entrance(front)/roof(gable)，windows 数组只允许 wall=front 的项）与 kind=path（石板路：points 为 2 到 64 个 [x,z] 二维点，width 0.4 到 4）与 kind=character（村民：position 为 [x,y,z] 且 y 取所在岛 elevation，可选 route 为 2 到 64 个 [x,z] 点、speed 米/秒；出生点与路线都必须在岛上且不进入任何建筑）。
村庄硬约束：
- house 最多 12 栋、path 最多 8 条、tree 最多 24 棵、character 最多 12 人；library/porch/bridge/water 仍恰好一个。
- 建筑之间（library、porch、所有 house 两两之间；门廊与书院搭接除外）需留 ≥0.6m 缝隙（含屋顶出檐）。
- 建筑四角（含出檐）不得伸入桥走廊（桥中心线两侧 bridge.width/2+0.3 内）。
- path 的所有点必须落在同一座岛上（含 width/2+voxelUnit/2 的离岸余量），且路径不得穿过任何建筑（含 width/2+0.15 余量）。
- 用户意图通常不给具体参数；你自己决定数量、尺寸、坐标与朝向，并保证全部约束满足。字段结构参考 example（一个完整村庄）。`;

const GEN_PROMPTS = {
  default: { system: GEN_SYSTEM, example: libraryScene },
  village: { system: VILLAGE_GEN_SYSTEM, example: villageScene },
};

const EDIT_SYSTEM = `你负责把文字意图改写成 Wispiva 的 3D 场景语义文档，不生成图片、网格或逐顶点数据。
只返回一个完整 JSON SceneDocument，不要 markdown。
坐标使用米制右手系、Y 向上。保留所有已有 id、连接与空间尺寸，除非用户明确要求修改。
后端负责把文档编译为通用几何或体素，不允许用后端私有字段。
可修改 style、regions、objects 中的参数和名称。支持 kind=water/island/library/porch/bridge/tree。
不得删除室内、门廊、桥或可进入空间；做不到的内容不要虚构为新类型。
输出必须满足 schemaVersion=1，所有数值有限，尺寸为正。`;

// ---------- 模型客户端 ----------

class BudgetExhaustedError extends Error {}

function readCliSettings() {
  const cli = {};
  const model = flag('model'), baseUrl = flag('base-url'), key = flag('api-key');
  if (typeof model === 'string') cli.model = model;
  if (typeof baseUrl === 'string') cli.baseUrl = baseUrl;
  if (typeof key === 'string') cli.apiKey = key;
  return cli;
}

async function resolveRealSettings() {
  let settings = { baseUrl: 'https://api.groq.com/openai/v1', model: '', maxCallsDay: maxCalls };
  const settingsFile = join(dataDir, 'settings.json');
  if (existsSync(settingsFile)) settings = { ...settings, ...JSON.parse(await readFile(settingsFile, 'utf8')) };
  if (process.env.GROQ_API_KEY) settings.apiKey = process.env.GROQ_API_KEY;
  Object.assign(settings, readCliSettings());
  settings.maxCallsDay = Number(flag('max-calls', settings.maxCallsDay));
  if (!settings.apiKey || !settings.model) {
    throw new Error('真实模式需要模型配置：在 .data/geometry-lab/settings.json 写入 {baseUrl, model, apiKey}，或设置 GROQ_API_KEY 并传 --model=<名称>');
  }
  return settings;
}

class RealClient {
  constructor(settings) {
    this.settings = settings;
    this.calls = 0;
  }
  async call({ phase, intentId, system, user }) {
    if (this.calls >= this.settings.maxCallsDay) throw new BudgetExhaustedError(`已达到本轮 ${this.settings.maxCallsDay} 次调用预算`);
    this.calls++;
    const body = {
      model: this.settings.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
      max_completion_tokens: 6000,
    };
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    try {
      const response = await fetch(`${this.settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.settings.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });
      const raw = await response.text();
      const data = JSON.parse(raw);
      const usage = data.usage ?? null;
      await this.audit({ phase, intentId, startedAt, status: response.status, latencyMs: Date.now() - t0, usage });
      if (!response.ok) throw new Error(`模型服务返回 ${response.status}`);
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error('模型没有返回内容');
      return JSON.parse(content.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
    } catch (error) {
      await this.audit({ phase, intentId, startedAt, status: 'client-error', latencyMs: Date.now() - t0, error: String(error) });
      throw error;
    }
  }
  async audit(entry) {
    await appendFile(auditFile, `${JSON.stringify({ id: randomUUID(), model: this.settings.model, ...entry })}\n`, { mode: 0o600 });
  }
  generate(intent) {
    const { system, example } = GEN_PROMPTS[intent.flavor ?? 'default'];
    return this.call({ phase: 'generate', intentId: intent.id, system, user: JSON.stringify({ intent: intent.text, example }) });
  }
  revise(intent, instruction, document) {
    return this.call({ phase: 'revise', intentId: intent.id, system: EDIT_SYSTEM, user: JSON.stringify({ instruction, document, example: libraryScene }) });
  }
  async hasRepair() { return true; }
  async repair(intent, document, errors) {
    const instruction = `你上次的输出未通过结构校验。只修复诊断指出的问题并保持其余内容不变，返回完整 JSON SceneDocument。诊断：\n${errors.map(e => `- ${e}`).join('\n')}`;
    return this.call({ phase: 'repair', intentId: intent.id, system: EDIT_SYSTEM, user: JSON.stringify({ instruction, document, example: libraryScene }) });
  }
}

// mock 模型：直接返回参考解；修订只改门廊宽度。用于验证管道本身。
class MockClient {
  constructor() { this.calls = 0; }
  async delay() { await new Promise(resolve => setTimeout(resolve, 5)); }
  async generate(intent) {
    this.calls++;
    await this.delay();
    return structuredClone(intent.reference);
  }
  async revise(instruction, document) {
    this.calls++;
    await this.delay();
    const next = structuredClone(document);
    next.objects.find(o => o.kind === 'porch').bounds.width += 1.2;
    return next;
  }
}

// 离线模型：从目录读取人工准备的“模型输出”（<intentId>.generate.json / .revise.json / .repair.json）。
// 用于让会话模型充当生成模型；每个意图只记录首次输出与一次诊断返修，不反复重试。
class GeneratedClient {
  constructor(dir) { this.dir = dir; this.calls = 0; }
  async load(file) {
    const text = await readFile(join(this.dir, file), 'utf8');
    return JSON.parse(text);
  }
  async generate(intent) {
    this.calls++;
    return this.load(`${intent.id}.generate.json`);
  }
  async hasRepair(intent) {
    return existsSync(join(this.dir, `${intent.id}.repair.json`));
  }
  async repair(intent, document, errors) {
    this.calls++;
    return this.load(`${intent.id}.repair.json`);
  }
  async revise(intent, instruction, document) {
    this.calls++;
    return this.load(`${intent.id}.revise.json`);
  }
}

// ---------- 语义 diff 与期望脏部件 ----------

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function byId(nodes) {
  return Object.fromEntries((nodes ?? []).filter(Boolean).map(node => [node.id, node]));
}

// 期望的重建部件由语义变化推导（与编译器 recipeHash 的内容键对应）：
// style → 全部；regions → terrain（water 或首个 island 变化再加 nature）；
// library → library+interior；porch → porch；bridge → bridge；树集合 → nature。
function expectedParts(prev, next) {
  const expected = new Set();
  if (!sameJson(prev?.style, next?.style)) return [...ALL_PARTS];
  const prevRegions = byId(prev?.regions), nextRegions = byId(next?.regions);
  const regionIds = new Set([...Object.keys(prevRegions), ...Object.keys(nextRegions)]);
  for (const id of regionIds) {
    if (!sameJson(prevRegions[id], nextRegions[id])) {
      expected.add('terrain');
      const region = nextRegions[id] ?? prevRegions[id];
      if (region?.kind === 'water' || region === nextRegions[Object.keys(nextRegions)[0]]) expected.add('nature');
    }
  }
  const pair = (kind, ...parts) => {
    const a = prev?.objects?.find(o => o?.kind === kind), b = next?.objects?.find(o => o?.kind === kind);
    if (!sameJson(a, b)) for (const part of parts) expected.add(part);
  };
  pair('library', 'library', 'interior');
  pair('porch', 'porch');
  pair('bridge', 'bridge');
  const prevTrees = byId(prev?.objects?.filter(o => o?.kind === 'tree'));
  const nextTrees = byId(next?.objects?.filter(o => o?.kind === 'tree'));
  const treeIds = new Set([...Object.keys(prevTrees), ...Object.keys(nextTrees)]);
  for (const id of treeIds) if (!sameJson(prevTrees[id], nextTrees[id])) { expected.add('nature'); break; }
  return [...expected];
}

// ---------- 实验 ----------

function sceneStats(world) {
  let triangles = 0, batches = 0, instances = 0;
  world.traverse(node => {
    if (!node.isMesh) return;
    batches++;
    if (node.isInstancedMesh) instances += node.count;
    const geometry = node.geometry;
    triangles += (geometry.index ? geometry.index.count : geometry.attributes?.position?.count ?? 0) / 3;
  });
  return { triangles: Math.round(triangles), batches, instances };
}

function documentErrors(doc) {
  return [...validateSceneDocument(doc), ...validateSpatialLayout(doc)].map(formatDiagnostic);
}

async function compileBothBackends(doc) {
  const perBackend = {};
  const worlds = {};
  for (const backend of BACKENDS) {
    try {
      const world = compileScene(doc, backend, options);
      perBackend[backend] = { ok: true, ...sceneStats(world) };
      worlds[backend] = world;
    } catch (error) {
      perBackend[backend] = {
        ok: false,
        errors: error instanceof SceneCompileError ? error.diagnostics.map(formatDiagnostic) : [String(error)],
      };
    }
  }
  return { perBackend, worlds };
}

async function runRevision(client, budget, intent, baseDoc, worlds) {
  const result = { attempted: false, ok: false };
  if (!intent.revision) return result;
  if (budget.remaining <= 0) { result.skipped = 'budget'; return result; }
  result.attempted = true;
  budget.remaining--;
  let revised;
  try {
    revised = await client.revise(intent, intent.revision.instruction, baseDoc);
  } catch (error) {
    result.error = String(error.message ?? error);
    return result;
  }
  const errors = documentErrors(revised);
  if (errors.length) {
    result.stage = 'validate';
    result.errors = errors;
    return result;
  }
  result.ok = true;
  result.rebuilt = {};
  result.expected = expectedParts(baseDoc, revised);
  for (const backend of BACKENDS) {
    if (!worlds[backend]) { result.rebuilt[backend] = 'baseline-compile-failed'; continue; }
    try {
      const world = prepareSceneUpdate(revised, backend, { ...options, world: worlds[backend] }, []).commit();
      result.rebuilt[backend] = world.userData.rebuiltParts;
    } catch (error) {
      result.rebuilt[backend] = { error: error instanceof SceneCompileError ? error.diagnostics.map(formatDiagnostic) : [String(error)] };
    }
  }
  result.overreach = {};
  for (const backend of BACKENDS) {
    const rebuilt = result.rebuilt[backend];
    if (Array.isArray(rebuilt)) {
      result.overreach[backend] = rebuilt.filter(part => !result.expected.includes(part));
      result.missing = (result.missing ?? []).concat(result.expected.filter(part => !rebuilt.includes(part)));
    }
  }
  return result;
}

async function runIntent(client, budget, intent) {
  const record = { id: intent.id, title: intent.title, generate: {}, revise: null };
  if (budget.remaining <= 0) {
    record.generate = { attempted: false, skipped: 'budget' };
    return record;
  }
  budget.remaining--;
  record.generate.attempted = true;
  record.generate.attempts = [];
  let doc;
  try {
    doc = await client.generate(intent);
  } catch (error) {
    record.generate = { attempted: true, ok: false, stage: error instanceof BudgetExhaustedError ? 'budget' : 'model', error: String(error.message ?? error) };
    return record;
  }
  let errors = documentErrors(doc);
  record.generate.attempts.push({ stage: 'first', ok: errors.length === 0, errors: errors.length ? errors : undefined });
  // 诊断返修：把结构化诊断喂回模型修一次；是否救回本身就是实验数据。
  if (errors.length && budget.remaining > 0 && await client.hasRepair(intent)) {
    budget.remaining--;
    try {
      const repaired = await client.repair(intent, doc, errors);
      const repairErrors = documentErrors(repaired);
      record.generate.attempts.push({ stage: 'repair', ok: repairErrors.length === 0, errors: repairErrors.length ? repairErrors : undefined });
      if (!repairErrors.length) { doc = repaired; errors = repairErrors; }
    } catch (error) {
      record.generate.attempts.push({ stage: 'repair', ok: false, error: String(error.message ?? error) });
    }
  }
  if (errors.length) {
    record.generate = { ...record.generate, ok: false, stage: 'validate', errors };
    return record;
  }
  const { perBackend, worlds } = await compileBothBackends(doc);
  record.generate = { ...record.generate, attempted: true, ok: true, perBackend, repaired: record.generate.attempts.length > 1 };
  record.document = doc;
  try {
    const anyCompiled = BACKENDS.some(b => worlds[b]);
    record.revise = anyCompiled ? await runRevision(client, budget, intent, doc, worlds) : { attempted: false, skipped: 'no-backend' };
  } finally {
    for (const world of Object.values(worlds)) disposeWorld(world);
  }
  return record;
}

// ---------- 汇总 ----------

function summarize(records) {
  const attempted = records.filter(r => r.generate?.attempted && !r.generate?.skipped);
  const valid = attempted.filter(r => r.generate.ok);
  const compiled = backend => valid.filter(r => r.generate.perBackend[backend]?.ok);
  const revised = valid.filter(r => r.revise?.attempted);
  const revisedOk = revised.filter(r => r.revise.ok);
  const clean = revised.filter(r => r.revise.ok && BACKENDS.every(b => (r.revise.overreach?.[b] ?? []).length === 0));
  const repaired = valid.filter(r => r.generate.repaired);
  return {
    intents: records.length,
    attempted: attempted.length,
    documentValid: valid.length,
    firstPass: valid.length - repaired.length,
    savedByRepair: repaired.length,
    solidCompiled: compiled('solid').length,
    voxelCompiled: compiled('voxel').length,
    revisionsAttempted: revised.length,
    revisionsValid: revisedOk.length,
    revisionsClean: clean.length,
  };
}

function markdownReport(meta, records, summary) {
  const lines = [
    `# 生成对照实验报告`, '',
    `- 日期：${meta.date}`, `- 模式：${meta.mode}${meta.mode === 'mock' ? '（参考解验证管道）' : meta.mode === 'real' ? `（${meta.model}）` : '（会话模型离线输出）'}`,
    `- 预算：${meta.budget} 次；实际调用：${meta.calls}`, '',
    `## 汇总`, '',
    `| 指标 | 数值 |`, `| --- | ---: |`,
    ...Object.entries(summary).map(([k, v]) => `| ${k} | ${v} |`),
    '', `## 明细`, '',
    `| 意图 | 文档校验 | solid 编译 | voxel 编译 | 修订 | rebuilt(solid) | rebuilt(voxel) | 越界重建 |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- |`,
  ];
  for (const r of records) {
    const g = r.generate;
    const gen = g.skipped ? `跳过(${g.skipped})`
      : !g.ok ? `失败@${g.stage}`
      : `${BACKENDS.map(b => g.perBackend[b].ok ? '✓' : '✗').join('/')}${g.repaired ? '(返修)' : ''}`;
    const solid = g.ok ? (g.perBackend.solid.ok ? `${g.perBackend.solid.triangles}△/${g.perBackend.solid.batches}批` : '失败') : '—';
    const voxel = g.ok ? (g.perBackend.voxel.ok ? `${g.perBackend.voxel.triangles}△/${g.perBackend.voxel.batches}批` : '失败') : '—';
    const rv = r.revise;
    const rev = !rv ? '—' : rv.skipped ? `跳过(${rv.skipped})` : !rv.attempted ? '—' : !rv.ok ? `失败@${rv.stage ?? 'model'}` : '✓';
    const rebuilt = b => rv?.rebuilt?.[b] ? (Array.isArray(rv.rebuilt[b]) ? rv.rebuilt[b].join(',') : JSON.stringify(rv.rebuilt[b])) : '—';
    const over = rv?.overreach ? BACKENDS.map(b => rv.overreach[b]?.length ? `${b}:${rv.overreach[b].join(',')}` : null).filter(Boolean).join(' ') || '无' : '—';
    lines.push(`| ${r.id} | ${gen} | ${solid} | ${voxel} | ${rev} | ${rebuilt('solid')} | ${rebuilt('voxel')} | ${over} |`);
  }
  const failures = [];
  for (const r of records) {
    if (r.generate && !r.generate.ok && r.generate.errors?.length) failures.push([r.id, 'generate', r.generate.errors]);
    if (r.revise && r.revise.attempted && !r.revise.ok && r.revise.errors?.length) failures.push([r.id, 'revise', r.revise.errors]);
    if (r.generate?.ok) for (const b of BACKENDS) {
      const per = r.generate.perBackend[b];
      if (!per.ok) failures.push([r.id, `compile:${b}`, per.errors]);
    }
  }
  if (failures.length) {
    lines.push('', `## 失败诊断`, '');
    for (const [id, stage, errors] of failures) lines.push(`- **${id} / ${stage}**：${errors.join('；')}`);
  }
  return lines.join('\n');
}

// ---------- 主流程 ----------

const generatedDir = flag('generated', null);
const settings = mock ? null : generatedDir ? null : await resolveRealSettings();
const client = mock ? new MockClient() : generatedDir ? new GeneratedClient(generatedDir) : new RealClient(settings);
const budget = { remaining: mock || generatedDir ? Infinity : Number(flag('max-calls', settings.maxCallsDay)) };
const pool = allIntents.filter(i => (mock ? true : !i.mockOnly) && intentIds.includes(i.id));
const records = [];
for (const intent of pool) {
  process.stdout.write(`运行意图 ${intent.id} …\n`);
  records.push(await runIntent(client, budget, intent));
}
const summary = summarize(records);
const meta = {
  date: new Date().toISOString(),
  mode: mock ? 'mock' : generatedDir ? `generated:${generatedDir}` : 'real',
  model: settings?.model ?? (generatedDir ? 'session-model' : 'mock'),
  budget: mock || generatedDir ? '∞' : budget.remaining + client.calls,
  calls: client.calls,
};
await writeFile(join(outDir, 'report.json'), `${JSON.stringify({ meta, summary, records }, null, 2)}\n`);
await writeFile(join(outDir, 'report.md'), `${markdownReport(meta, records, summary)}\n`);
console.log(markdownReport(meta, records, summary));
console.log(`\n报告已写入 ${outDir}`);
