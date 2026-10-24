import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Experiment, validateWorld } from './core.js';
import { complete, demoBeat, messagesFor, proposeEdit } from './llm.js';
import { GROQ_MODELS } from './seed.js';

const root = dirname(fileURLToPath(import.meta.url));
const defaults = {
  mode: process.env.GROQ_API_KEY ? 'live' : 'demo',
  baseUrl: 'https://api.groq.com/openai/v1',
  model: 'openai/gpt-oss-120b',
  fallbacks: ['qwen/qwen3.8-27b', 'openai/gpt-oss-20b'],
  strict: true, beatMinutes: 60, maxTokens: 2500,
  maxCallsHour: 40, maxCallsDay: 200, minIntervalSeconds: 60,
};

export function createPrototype({ dataDir = process.env.WISPIVA_DATA_DIR || join(root, '.data'), port = Number(process.env.PORT || 8137), request = fetch } = {}) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, 'worlds.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS experiment (id INTEGER PRIMARY KEY CHECK (id=1), json TEXT NOT NULL)');
  const stored = db.prepare('SELECT json FROM experiment WHERE id=1').get();
  const write = db.prepare('INSERT INTO experiment(id,json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json');
  const experiment = new Experiment(stored ? JSON.parse(stored.json) : null, data => write.run(JSON.stringify(data)));
  for (const call of experiment.data.calls) if (call.status === 'pending') call.status = 'interrupted';
  experiment.data.requests ||= [];
  const settingsPath = join(dataDir, 'settings.json');
  let settings = { ...defaults, ...(existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {}) };
  if (process.env.GROQ_API_KEY) settings.apiKey = process.env.GROQ_API_KEY;
  let jobs = 0, closed = false, cursor = 0;
  const publicSettings = () => {
    const { apiKey, ...rest } = settings;
    return { ...rest, keyConfigured: !!apiKey, models: GROQ_MODELS };
  };
  function usage() {
    const now = Date.now();
    return {
      hour: experiment.data.requests.filter(t => now - t < 3600000).length,
      day: experiment.data.requests.filter(t => now - t < 86400000).length,
      tokens: experiment.data.calls.reduce((n, c) => n + (c.usage?.total_tokens || 0), 0),
    };
  }
  function resumedSettings(nextModel) {
    const config = structuredClone(settings);
    const roster = [...new Set([config.model, ...config.fallbacks])];
    const cursor = roster.indexOf(nextModel);
    if (cursor > 0) {
      config.model = roster[cursor];
      config.fallbacks = roster.slice(cursor + 1);
    }
    return config;
  }
  async function meteredFetch(url, options) {
    if (closed) throw new Error('服务正在退出');
    const u = usage(), now = Date.now();
    const last = experiment.data.requests.at(-1) || 0;
    const delay = last + settings.minIntervalSeconds * 1000 - now;
    if (u.hour >= settings.maxCallsHour || u.day >= settings.maxCallsDay || delay > 0) {
      const error = new Error(delay > 0 ? '等待用户配置的调用间隔' : '已到用户配置的调用上限；世界等待下一次额度');
      error.name = 'BudgetError';
      error.retryAfterMs = Math.max(1000, delay, u.hour >= settings.maxCallsHour ? 60000 : 0, u.day >= settings.maxCallsDay ? 300000 : 0);
      throw error;
    }
    experiment.data.requests.push(now);
    experiment.data.requests = experiment.data.requests.filter(t => now - t < 86400000);
    experiment.persist();
    return request(url, options);
  }
  async function generate(line) {
    const config = resumedSettings(line.nextModel);
    const call = experiment.begin(line.id, 'beat', { mode: config.mode, requestedModel: config.model });
    if (!call) return;
    jobs++;
    try {
      const messages = messagesFor(experiment.world(line.id), experiment.history(line.id).slice(-12), { span: config.beatMinutes, time: call.startTime });
      call.messages = messages;
      let result;
      if (config.mode === 'demo') {
        await new Promise(resolve => setTimeout(resolve, 250));
        result = { payload: demoBeat(experiment.world(line.id), experiment.history(line.id), config.beatMinutes), model: 'demo', usage: {}, attempts: [] };
      } else result = await complete(config, messages, 'beat', meteredFetch);
      if (closed) return;
      Object.assign(call, { model: result.model, usage: result.usage, attempts: result.attempts });
      if (experiment.accept(line.id, call, result.payload, config.beatMinutes)) line.nextModel = null;
    } catch (error) {
      if (closed) return;
      if (line.inFlight === call.id) line.nextModel = error.resumeModel || null;
      if (error.attempts) call.attempts = error.attempts;
      experiment.fail(line.id, call, error);
    } finally { jobs--; }
  }
  function pump() {
    if (closed) return;
    experiment.tick();
    const lines = Object.values(experiment.data.lines);
    for (let n = 0; n < lines.length && jobs < 2; n++) {
      const line = lines[(cursor + n) % lines.length];
      if (!line.paused && !line.plan && !line.inFlight && line.retryAt <= Date.now()) void generate(line);
    }
    cursor = (cursor + 1) % Math.max(lines.length, 1);
  }
  function snapshot() {
    experiment.tick();
    return { lines: experiment.snapshot(), settings: publicSettings(), usage: usage(), serverTime: Date.now(), calls: experiment.data.calls.slice(-25).map(c => ({
      id: c.id, lineId: c.lineId, kind: c.kind, model: c.model || c.requestedModel, mode: c.mode,
      status: c.status, startedAt: c.startedAt, finishedAt: c.finishedAt, usage: c.usage, error: c.error,
    })) };
  }
  async function readBody(req) {
    let text = '';
    for await (const part of req) {
      text += part;
      if (text.length > 300000) throw new Error('请求内容过大');
    }
    return text ? JSON.parse(text) : {};
  }
  function updateSettings(body) {
    const next = { ...settings };
    for (const k of ['mode', 'baseUrl', 'model', 'strict', 'fallbacks']) if (body[k] !== undefined) next[k] = body[k];
    if (!['live', 'demo'].includes(next.mode)) throw new Error('请选择真实 LLM 或演示模式');
    const url = new URL(next.baseUrl);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('服务地址需要 HTTPS 或本机 HTTP');
    if (!Array.isArray(next.fallbacks) || next.fallbacks.length > 4 || next.fallbacks.some(m => typeof m !== 'string')) throw new Error('备用模型最多四个');
    if (typeof next.model !== 'string' || !next.model.trim()) throw new Error('请选择模型');
    for (const [key, min, max] of [
      ['beatMinutes', 1, 1440], ['maxTokens', 256, 6000], ['maxCallsHour', 1, 1000], ['maxCallsDay', 1, 10000], ['minIntervalSeconds', 0, 3600],
    ]) {
      if (body[key] !== undefined) {
        const val = Number(body[key]);
        if (!Number.isFinite(val) || val < min || val > max) throw new Error(`${key} 范围为 ${min}–${max}`);
        next[key] = val;
      }
    }
    if (body.apiKey?.trim()) next.apiKey = body.apiKey.trim();
    if (body.clearKey) delete next.apiKey;
    settings = next;
    const diskSettings = { ...settings };
    if (process.env.GROQ_API_KEY && diskSettings.apiKey === process.env.GROQ_API_KEY) delete diskSettings.apiKey;
    writeFileSync(settingsPath, JSON.stringify(diskSettings, null, 2), { mode: 0o600 });
    for (const line of Object.values(experiment.data.lines)) {
      line.plan = null; line.inFlight = null; line.retryAt = 0; line.error = null; line.nextModel = null;
    }
    experiment.persist();
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (value, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      if (req.headers.origin) {
        const origin = new URL(req.headers.origin);
        if (!['127.0.0.1', 'localhost'].includes(origin.hostname) || origin.host !== req.headers.host) return send({ error: '仅允许本机页面操作原型' }, 403);
      }
      if (path === '/api/state' && req.method === 'GET') return send(snapshot());
      if (path === '/api/settings' && req.method === 'POST') {
        updateSettings(await readBody(req)); return send(publicSettings());
      }
      if (path === '/api/draft' && req.method === 'POST') {
        const { lineId } = await readBody(req); return send(experiment.draft(lineId || null));
      }
      if (path === '/api/confirm' && req.method === 'POST') {
        const { draftId, world, name } = await readBody(req);
        return send({ lineId: experiment.confirm(draftId, world, name).id });
      }
      if (path === '/api/control' && req.method === 'POST') {
        const { lineId, ...body } = await readBody(req);
        experiment.control(lineId, body); pump(); return send(snapshot());
      }
      if (path === '/api/edit' && req.method === 'POST') {
        const { draftId, world, instruction } = await readBody(req);
        const draft = experiment.data.drafts[draftId];
        if (!draft) throw new Error('编辑草稿不存在');
        validateWorld(world);
        const call = draft.lineId ? experiment.begin(draft.lineId, 'edit', { mode: settings.mode, draftId, baseRevision: draft.head, startTime: draft.worldTime }) : { id: draftId, mode: settings.mode, kind: 'edit', status: 'pending', startedAt: Date.now(), startTime: draft.worldTime };
        if (!draft.lineId) experiment.data.calls.push(call);
        try {
          const result = await proposeEdit(resumedSettings(draft.nextModel), world, instruction, meteredFetch, draft.worldTime);
          draft.nextModel = null;
          Object.assign(call, { status: 'accepted', messages: result.messages, attempts: result.attempts || [], model: result.model || 'demo', usage: result.usage, finishedAt: Date.now() });
          experiment.persist();
          return send({ world: result.world, explanation: result.explanation });
        } catch (error) {
          draft.nextModel = error.resumeModel || null;
          Object.assign(call, { status: 'failed', error: error.message, attempts: error.attempts || [], finishedAt: Date.now() });
          experiment.persist(); throw error;
        }
      }
      if (path === '/api/export' && req.method === 'GET') {
        res.setHeader('Content-Disposition', 'attachment; filename=\"wispiva-worlds.json\"');
        return send({ version: 2, lines: experiment.snapshot(), exportedAt: new Date().toISOString() });
      }
      const staticFiles = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/renderers.js': 'renderers.js', '/seed.js': 'seed.js' };
      if (req.method === 'GET' && staticFiles[path]) {
        const file = staticFiles[path];
        res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' });
        res.end(readFileSync(join(root, file))); return;
      }
      send({ error: '未找到页面或接口' }, 404);
    } catch (error) { send({ error: error.message }, 400); }
  });
  const interval = setInterval(pump, 250);
  interval.unref();
  return {
    experiment, publicSettings, snapshot, pump,
    async start() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      return server.address().port;
    },
    async close() {
      closed = true; clearInterval(interval);
      experiment.persist();
      await new Promise(resolve => server.close(resolve));
      db.close();
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const app = createPrototype();
  const port = await app.start();
  console.log(`Wispiva prototype: http://127.0.0.1:${port}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
