import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Experiment, changedPaths, validateWorld } from './core.js';
import { complete, messagesFor, proposeEdit } from './llm.js';
import { GROQ_MODELS } from './seed.js';

if (!process.env.GROQ_API_KEY) {
  console.error('需要 GitHub Actions secret GROQ_API_KEY；没有发起任何真实调用。');
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const artifacts = join(here, 'artifacts');
mkdirSync(artifacts, { recursive: true });
const settings = { mode: 'live', apiKey: process.env.GROQ_API_KEY, baseUrl: 'https://api.groq.com/openai/v1', strict: true, maxTokens: 3000, fallbacks: [] };
const report = { at: new Date().toISOString(), provider: 'Groq', models: [], scenarios: [], realLlm: true, modelSelection: '先比较免费额度表中的三个候选；推荐以结构正确、中文剧情和修改遵从共同判断。' };
const lastUse = new Map();
let requestCount = 0;
async function pacedRequest(url, options) {
  const model = JSON.parse(options.body).model;
  while (Date.now() < (lastUse.get(model) || 0) + 65000) await new Promise(resolve => setTimeout(resolve, 1000));
  if (requestCount >= 6) throw new Error('本次真实推演最多六次请求，已停止继续调用');
  lastUse.set(model, Date.now());
  requestCount++;
  console.log(`Groq request ${requestCount}/6 · ${model}`);
  return fetch(url, options);
}
function save() {
  report.requestCount = requestCount;
  writeFileSync(join(artifacts, 'groq-observations.json'), JSON.stringify(report, null, 2));
}
const usable = [];
for (const candidate of GROQ_MODELS) {
  let now = 0;
  const e = new Experiment(null, () => {}, () => now);
  const line = Object.values(e.data.lines)[0];
  e.control(line.id, { paused: false });
  const call = e.begin(line.id, 'beat', { mode: 'live' });
  const messages = messagesFor(e.world(line.id), e.history(line.id), { span: 60, time: line.worldTime });
  try {
    const result = await complete({ ...settings, model: candidate.id }, messages, 'beat', pacedRequest);
    if (!result.payload.events?.length) throw new Error('没有产生事件，无法观察叙事质量');
    e.accept(line.id, call, result.payload, 60);
    now = 150000; e.tick();
    const record = {
      model: candidate.id, ok: true, latencyMs: result.latencyMs, usage: result.usage,
      events: e.history(line.id).filter(x => x.kind === 'story'),
      memories: e.world(line.id).memories,
      finalWorld: e.world(line.id),
      factChangeCount: changedPaths(e.data.revisions[call.baseRevision].world, e.world(line.id)).length,
    };
    report.models.push(record);
    usable.push({ candidate, e, line, advance: minutes => { now += minutes / line.speed * 60000; e.tick(); } });
    console.log(`${candidate.id}: accepted ${record.events.length} events, ${record.factChangeCount} fact changes`);
  } catch (error) {
    report.models.push({ model: candidate.id, ok: false, error: error.message });
    console.log(`${candidate.id}: ${error.message}`);
  }
  save();
}
if (!usable.length) {
  report.realLlm = false; save();
  throw new Error('三个候选均未产生可提交的真实事件，请查看无密钥的观察报告');
}
const selected = usable[0];
report.recommendedModel = selected.candidate.id;
settings.model = selected.candidate.id;
const { e, line } = selected;
try {
  const draft = e.draft(line.id);
  const proposal = await proposeEdit(settings, draft.world, '同时做三项修改：老周决定主动公开六十年前的真相；沈青梧决定保护老周而不再追问父亲；白薇决定阻止开发商封闭戏台。请修改三人的目标，保留其余事实与原有记忆。', pacedRequest, draft.worldTime);
  validateWorld(proposal.world);
  const paths = changedPaths(draft.world, proposal.world);
  const child = e.confirm(draft.id, proposal.world, '如果他们选择公开真相');
  report.scenarios.push({ name: 'LLM-editor-multiple-changes', ok: paths.length >= 3, explanation: proposal.explanation, changes: paths, world: proposal.world, baseWorldTime: draft.worldTime });
  const call = e.begin(child.id, 'beat', { mode: 'live' });
  const messages = messagesFor(e.world(child.id), e.history(child.id).slice(-12), { span: 60, time: child.worldTime });
  const result = await complete(settings, messages, 'beat', pacedRequest);
  e.accept(child.id, call, result.payload, 60);
  selected.advance(60);
  report.scenarios.push({
    name: 'real-branch-continuation', ok: true, model: settings.model,
    originalWorldUnchanged: JSON.stringify(e.world(line.id)) === JSON.stringify(draft.world),
    editedGoals: Object.fromEntries(['zhou', 'shen', 'bai'].map(k => [k, e.world(child.id).entities[k]?.goal])),
    events: e.history(child.id).filter(x => x.kind === 'story' && !e.history(line.id).some(y => y.id === x.id)),
  });
  const world = structuredClone(e.world(child.id));
  world.memories.push({ id: 'old-promise-observation', text: '多年前陆则郑重答应过沈青梧：绝不把她父亲的私人信件交给开发商。', knownBy: ['lu', 'shen'], source: 'observation-earlier-history' });
  const noise = Array.from({ length: 12 }, (_, n) => ({ time: child.worldTime - 12 + n, text: '镇上的人照常忙碌，市场逐渐热闹起来。' }));
  const memoryResult = await complete(settings, messagesFor(world, noise, { span: 60, time: child.worldTime }), 'beat', pacedRequest);
  const check = new Experiment();
  const checkLine = Object.values(check.data.lines)[0];
  const memoryDraft = check.draft(checkLine.id);
  const memoryLine = check.confirm(memoryDraft.id, world, '长期记忆观察');
  const memoryCall = check.begin(memoryLine.id, 'beat', { mode: 'live' });
  check.accept(memoryLine.id, memoryCall, memoryResult.payload, 60);
  report.scenarios.push({ name: 'long-term-fact-in-real-prompt', ok: true, oldFactProvidedOutsideRecentLog: true, events: memoryResult.payload.events, note: '记录真实输出供人工判断是否保持承诺；一次输出不能证明长期人物一致性。' });
} catch (error) {
  report.scenarios.push({ name: 'editor-and-branch-sequence', ok: false, error: error.message });
  process.exitCode = 1;
}
save();
console.log(`Groq observations saved; ${requestCount} real requests; preferred usable model ${report.recommendedModel}.`);
