import { applyOps } from './core.js';

const objectSchema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const array = items => ({ type: 'array', items });
const string = { type: 'string' };
const opSchema = objectSchema({ op: { type: 'string', enum: ['set', 'remove'] }, path: string, valueJson: string });
const memorySchema = objectSchema({ text: string, knownBy: array(string) });
export const BEAT_SCHEMA = objectSchema({ events: array(objectSchema({
  offsetMinutes: { type: 'number' }, text: string, ops: array(opSchema), memories: array(memorySchema),
})) });
const EDIT_SCHEMA = objectSchema({ explanation: string, ops: array(opSchema) });

export function messagesFor(world, recent, { span = 60, time = 480, instruction = null } = {}) {
  const charId = Object.keys(world.entities).find(k => world.entities[k].kind === 'character');
  const placeId = Object.keys(world.entities).find(k => world.entities[k].kind === 'place');
  const exampleOps = charId && placeId ? [{ op: 'set', path: `/entities/${charId}/location`, valueJson: JSON.stringify(placeId) }] : [];
  const system = `你是Wispiva的世界推演者。所有输出为JSON。用户的世界文档是本世界的完整设定与现状，可以包含任意扩展字段。由你决定角色行为和事件，系统不预设剧情或物理规则。保持因果和人物动机连贯，尊重用户设定。你知道世界的秘密不代表角色知道：角色只能依据自己的knowledge和knownBy包含自己的记忆行动。角色获知秘密必须有对话、观察等信息来源，不能凭空知道另一角色的秘密；不在场的角色不能自动得知谈话。只有真正公开的事实才用knownBy:["all"]。允许新增实体、改变目标/关系/物品/法则，不要只改变一句状态文字。地点与人物的空间属性用于画面展示，移动角色可修改location或position。
输出ops记录实际事实变化，与叙述保持一致。op为set/remove，path是相对于world文档自身根部的JSON Pointer，如/entities/角色ID/goal，绝对不要加/world前缀。valueJson是JSON编码后的值字符串（例如把目标设为逃离，valueJson为"\\"逃离\\""；remove时为"null"）。数组用数字下标或末尾/-追加。set会创建缺失的对象父路径，不会覆盖已有的标量父字段。角色的location引用存在的实体。长期承诺、关系变化、获得的知识写入每个事件的memories数组即可，不需再创建重复的memory字段；knownBy是知情者实体ID，公开事实用["all"]。不要删除未失效的重要记忆。
不输出markdown。这是虚构的故事实验。`;
  const user = JSON.stringify({
    task: instruction ? '按用户想法提出一组完整修改，尚未确认，不推进时间。用中文解释改了什么。' : `推演从世界第${time}分钟开始的未来${span}分钟。输出1至4个事件，offsetMinutes为相对于同一起点的分钟数，范围0到${span}，按时间排序。叙述使用中文，有细节和具体选择，允许安静的时间段，不强制高潮。`,
    ...(instruction ? { instruction } : {}),
    outputShapeExample: instruction ? { explanation: '说明你的修改', ops: exampleOps } : { events: [{ offsetMinutes: span / 2, text: '这里写实际发生的中文事件，与ops一致', ops: exampleOps, memories: [] }] },
    worldTimeMinutes: time, world, recentHistory: recent,
  });
  if (user.length > 22000) throw new Error('世界与长期记忆已超过本轮原型的单次上下文预算。请在编辑器整理事实或减少近期历史；系统没有静默丢弃记忆。');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

export async function complete(settings, messages, kind = 'beat', request = fetch) {
  if (!settings.apiKey) throw new Error('尚未配置 Groq API key；可以先选择演示模式');
  const schema = kind === 'edit' ? EDIT_SCHEMA : BEAT_SCHEMA;
  const models = [...new Set([settings.model, ...(settings.fallbacks || [])])].filter(Boolean);
  const attempts = [];
  for (const model of models) {
    const body = {
      model, messages, max_completion_tokens: settings.maxTokens || 2500,
      response_format: settings.strict === false ? { type: 'json_object' } : { type: 'json_schema', json_schema: { name: `wispiva_${kind}`, strict: true, schema } },
      ...(model.startsWith('openai/gpt-oss') ? { reasoning_effort: 'low' } : {}),
    };
    const start = Date.now();
    let res;
    try {
      res = await request(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
      });
    } catch (error) {
      if (error.name === 'BudgetError') {
        error.attempts = attempts;
        error.resumeModel = model;
        throw error;
      }
      const wrapped = new Error(error.name === 'TimeoutError' ? 'LLM 请求超时，世界停在最后确认的时间。' : 'LLM 连接失败，世界停在最后确认的时间。');
      wrapped.attempts = attempts;
      throw wrapped;
    }
    const raw = await res.text();
    attempts.push({ model, status: res.status, latencyMs: Date.now() - start, raw, request: body });
    if (!res.ok) {
      const retryMs = Math.max(1000, Number(res.headers.get('retry-after')) * 1000 || 30000);
      if ([404, 429, 503].includes(res.status) && model !== models.at(-1)) continue;
      const error = new Error(`Groq ${res.status}：${res.status === 429 ? '免费额度或速率限制，稍后可重试' : res.status === 401 ? 'API key 无效' : '模型请求失败，请检查模型、额度和结构化输出设置'}`);
      error.retryAfterMs = retryMs; error.attempts = attempts;
      throw error;
    }
    let data, payload;
    try {
      data = JSON.parse(raw);
      const content = data.choices?.[0]?.message?.content;
      if (!content || data.choices[0].finish_reason === 'length') throw new Error('输出不完整');
      payload = JSON.parse(content.replace(/^```(?:json)?\s{0,}/, '').replace(/\s*```$/, ''));
    } catch {
      const error = new Error('模型没有返回完整 JSON；请提高输出 token 上限后重试');
      error.attempts = attempts; throw error;
    }
    return { payload, model, attempts, usage: data.usage || {}, latencyMs: Date.now() - start };
  }
  throw new Error('没有可用模型');
}

export function demoBeat(world, history, span) {
  const chars = Object.entries(world.entities).filter(([, e]) => e.kind === 'character');
  const places = Object.keys(world.entities).filter(k => world.entities[k].kind === 'place');
  if (!chars.length || !places.length) return { events: [] };
  const turn = history.filter(e => e.kind === 'story').length;
  const [who, char] = chars[turn % chars.length];
  const other = chars[(turn + 1) % chars.length][1];
  const destination = places[(turn + 1) % places.length];
  const place = world.entities[destination].name;
  const texts = [
    `${char.name}在旧照片背面发现一行被水渍晕开的字。他想起自己的打算：${char.goal || '再看清楚一点'}，决定到${place}找${other.name}谈谈。`,
    `${char.name}没有直接问那个人的名字，而是向${other.name}提起了离开小镇的那一年。对方把茶杯握紧了一些。`,
    `${char.name}在${place}等到一通电话。来电的人只说：「照片别给开发商。」他把这句话记了下来。`,
    `${char.name}把一张纸条递给${other.name}，约定黄昏后再碰面。两人都没有提戏台，谈话却一直绕着它。`,
  ];
  return { events: [{
    offsetMinutes: span / 3, text: texts[turn % texts.length],
    ops: [{ op: 'set', path: `/entities/${who}/location`, valueJson: JSON.stringify(destination) }, { op: 'set', path: `/entities/${who}/state`, valueJson: JSON.stringify('正在追查一条新的线索') }],
    memories: [{ text: `${char.name}与${other.name}在第${turn + 1}段故事中交换过线索。`, knownBy: [who] }],
  }] };
}

export async function proposeEdit(settings, world, instruction, request, worldTime = 480) {
  if (!instruction?.trim()) throw new Error('先写下你想改变的事');
  const messages = messagesFor(world, [], { instruction, time: worldTime });
  if (settings.mode === 'demo') {
    return { world: { ...structuredClone(world), premise: `${world.premise || ''}\n用户的新设想：${instruction}` }, explanation: '演示模式把想法加入了世界设定。真实 LLM 模式会同时修改涉及的人物、关系与场景。', messages, mode: 'demo' };
  }
  const result = await complete(settings, messages, 'edit', request);
  return { ...result, world: applyOps(world, result.payload.ops), explanation: result.payload.explanation, messages, mode: 'live' };
}
