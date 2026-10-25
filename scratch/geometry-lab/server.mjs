import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { libraryScene, validateSceneDocument, validateSpatialLayout, formatDiagnostic, createLibraryDescription } from './src/scene-document.js';

const root = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.WISPIVA_LAB_DATA || join(root, '../../.data/geometry-lab');
const settingsFile = join(dataDir, 'settings.json');
const auditFile = join(dataDir, 'audit.jsonl');
await mkdir(dataDir, { recursive: true, mode: 0o700 });
let settings = { baseUrl: 'https://api.groq.com/openai/v1', model: '', maxCallsDay: 12 };
if (existsSync(settingsFile)) settings = { ...settings, ...JSON.parse(await readFile(settingsFile, 'utf8')) };
if (process.env.GROQ_API_KEY) settings.apiKey = process.env.GROQ_API_KEY;
const vite = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5173', '--strictPort'], { stdio: ['ignore', 'pipe', 'inherit'] });
vite.stdout.on('data', () => {});

const systemPrompt = `你负责把文字意图改写成 Wispiva 的 3D 场景语义文档，不生成图片、网格或逐顶点数据。
只返回一个完整 JSON SceneDocument，不要 markdown。
坐标使用米制右手系、Y 向上。保留所有已有 id、连接与空间尺寸，除非用户明确要求修改。
后端负责把文档编译为通用几何或体素，不允许用后端私有字段。
可修改 style、regions、objects 中的参数和名称。支持 kind=water/island/library/porch/bridge/tree。
不得删除室内、门廊、桥或可进入空间；做不到的内容不要虚构为新类型。
输出必须满足 schemaVersion=1，所有数值有限，尺寸为正。`;

async function requestModel(instruction, document) {
  if (!settings.apiKey || !settings.model) throw new Error('尚未配置模型端点、模型名和 API key');
  const usage = await dailyUsage();
  if (usage >= settings.maxCallsDay) throw new Error(`已达到原型每日 ${settings.maxCallsDay} 次调用上限`);
  const body = {
    model: settings.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify({ instruction, document, example: libraryScene }) },
    ],
    response_format: { type: 'json_object' },
    max_completion_tokens: 6000,
  };
  const startedAt = new Date().toISOString();
  const response = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(90000),
  });
  const raw = await response.text();
  const audit = { id: randomUUID(), startedAt, model: settings.model, status: response.status, instruction, request: body, raw };
  await writeFile(auditFile, `${JSON.stringify(audit)}\n`, { flag: 'a', mode: 0o600 });
  if (!response.ok) throw new Error(`模型服务返回 ${response.status}；详细响应仅保存在本地审计`);
  const data = JSON.parse(raw);
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('模型没有返回场景内容');
  const next = JSON.parse(content.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
  const errors = [...validateSceneDocument(next), ...validateSpatialLayout(next)];
  if (errors.length) throw new Error(`场景校验失败：${errors.map(formatDiagnostic).join('；')}`);
  return next;
}

async function dailyUsage() {
  if (!existsSync(auditFile)) return 0;
  const text = await readFile(auditFile, 'utf8');
  const day = new Date().toISOString().slice(0, 10);
  return text.split('\n').filter(line => line.includes(`"startedAt":"${day}`)).length;
}

async function jsonBody(request) {
  let text = '';
  for await (const chunk of request) {
    text += chunk;
    if (text.length > 1_000_000) throw new Error('请求过大');
  }
  return JSON.parse(text || '{}');
}

const server = http.createServer(async (request, response) => {
  if (!request.url.startsWith('/lab-api/')) {
    response.writeHead(404); response.end(); return;
  }
  response.setHeader('content-type', 'application/json; charset=utf-8');
  try {
    if (request.url === '/lab-api/settings' && request.method === 'GET') {
      const { apiKey, ...safe } = settings;
      response.end(JSON.stringify({ ...safe, keyConfigured: Boolean(apiKey), callsToday: await dailyUsage() }));
    } else if (request.url === '/lab-api/settings' && request.method === 'POST') {
      const body = await jsonBody(request);
      for (const key of ['baseUrl', 'model']) if (typeof body[key] === 'string') settings[key] = body[key].trim();
      if (body.apiKey?.trim()) settings.apiKey = body.apiKey.trim();
      if (body.clearKey) delete settings.apiKey;
      await writeFile(settingsFile, JSON.stringify(settings, null, 2), { mode: 0o600 });
      const { apiKey, ...safe } = settings;
      response.end(JSON.stringify({ ...safe, keyConfigured: Boolean(apiKey) }));
    } else if (request.url === '/lab-api/generate' && request.method === 'POST') {
      const body = await jsonBody(request);
      if (!body.instruction?.trim()) throw new Error('请填写要创建或修改的内容');
      const document = await requestModel(body.instruction.trim(), body.document || libraryScene);
      response.end(JSON.stringify({ document, description: createLibraryDescription(document) }));
    } else { response.writeHead(404); response.end(JSON.stringify({ error: '未知实验接口' })); }
  } catch (error) {
    response.writeHead(400); response.end(JSON.stringify({ error: error.message }));
  }
});
server.listen(5174, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { vite.kill(signal); server.close(() => process.exit()); });
