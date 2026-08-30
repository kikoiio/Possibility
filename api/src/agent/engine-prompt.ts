import type { EngineContext, ScheduleItem } from './engine-context'
import { renderModelItems } from './prompt'
import type { Memory } from './memory'
import type { ModelItem } from './types'

/** 引擎模式的提示词（五种 step 各一段指令；全部要求只输出 JSON，由 extractJson 解析容错） */

export interface PromptPair {
  system: string
  user: string
}

/** 从模型输出中提取 JSON 对象（剥离代码块、截取首尾花括号） */
export function extractJson(raw: string): unknown {
  const cleaned = raw.replace(/```(?:json)?/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('返回中未找到 JSON')
  return JSON.parse(cleaned.slice(start, end + 1))
}

function items(title: string, list: ModelItem[]): string {
  return renderModelItems(title, list)
}

/** 公共段：人设 + 世界/地点/同世界人物 + 当前状态/当日日程 + 记忆检索集 */
function buildEngineSystem(ctx: EngineContext): string {
  const { model, state, snapshot } = ctx
  const { world, locations, timeline } = snapshot

  const sourceMem = items('源记忆（来自你人生的底色）', model.memories)
  const settled = ctx.memories.length
    ? `## 后来的记忆（按时间先后）\n${ctx.memories
        .map((m) => `- ${m.simTime ? `[${m.simTime.slice(0, 16).replace('T', ' ')}] ` : ''}${m.content}`)
        .join('\n')}`
    : ''
  const memorySection = [sourceMem, settled].filter(Boolean).join('\n\n')

  const unknowns = model.unknowns.length
    ? model.unknowns.map((u) => `- ${u}`).join('\n')
    : '- （暂无明确标注的未知项）'
  const boundaryLines = model.boundaries.length ? model.boundaries.map((b) => `- ${b.text}`).join('\n') : ''

  const othersSection = ctx.others.length
    ? [
        '## 与你同在这个世界的人',
        ...ctx.others.map((o) => {
          const rel = o.relationMemories.length
            ? `\n  你与 TA 的相关记忆：${o.relationMemories.join('；')}`
            : ''
          return `- ${o.person.name}${o.publicProfile ? `：${o.publicProfile}` : ''}${rel}`
        }),
      ].join('\n')
    : ''

  const scheduleSection = ctx.scheduleItems
    ? `## 今日日程\n${ctx.scheduleItems
        .map((it) => `- ${it.start}-${it.end} @${it.location}：${it.activity}${it.kind === 'sleep' ? '（睡眠）' : ''}`)
        .join('\n')}`
    : '## 今日日程\n（尚未安排）'

  const sections = [
    `# 你是 ${ctx.person.name}\n以下是你的人物模型，带"（推断）"的条目是合理推测而非确证。`,
    items('身份与价值观', model.identity),
    items('行为模式', model.behavior),
    items('说话方式', model.speech),
    items('技能与爱好', model.skills),
    memorySection,
    items('关系', model.relationships),
    [
      '## 边界与未知（诚实红线）',
      '以下事情你不应声称知道或经历过：',
      boundaryLines,
      '你明确不知道的信息：',
      unknowns,
      '被问到未知项时，坦然说不知道，绝不编造细节来假装知道。',
    ]
      .filter(Boolean)
      .join('\n'),
    [
      '## 你生活的世界',
      `世界：${world.name}——${world.description}`,
      `地点：\n${locations.map((l) => `- ${l.name}：${l.description}`).join('\n')}`,
      `现在的时间：${timeline.simNow}`,
      timeline.parentTimelineId
        ? `你所在的是一条 what-if 分叉时间线，分叉点之前的主线记忆你同样拥有。\n分叉设定：${timeline.forkScenarioJson ?? ''}`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
    othersSection,
    [
      '## 当前状态',
      `地点：${state.location}；活动：${state.activity}；情绪：${state.mood}；近期目标：${state.goal}`,
    ].join('\n'),
    scheduleSection,
    [
      '## 表达约束',
      '- 你就是这个人，不要自称 AI、模型、助手或程序。',
      '- 不使用"模拟""仿真"等词描述自己的生活。',
      '- 你的言行要与世界背景的时代与常识一致。',
      '- 用中文，除非人物设定明显使用其他语言。',
    ].join('\n'),
  ]

  return sections.filter(Boolean).join('\n\n')
}

/** schedule：生成当日日程 */
export function buildSchedulePrompt(ctx: EngineContext): PromptPair {
  const locationNames = ctx.snapshot.locations.map((l) => l.name).join('、')
  const instruction = [
    '## 任务：安排今日日程',
    '为你安排今天的日程。只输出一个 JSON 对象（不要任何其他文字，不要代码块）：',
    '{"items": [{"start": "HH:MM", "end": "HH:MM", "location": "地点", "activity": "做什么", "kind": "可选"}]}',
    '要求：',
    '- 6-10 项，覆盖从现在到明早起床；跨夜用次日的时间继续排（HH:MM 即可，不用标日期）。',
    '- 时间升序、不重叠、首尾相接。',
    `- location 必须来自世界地点列表：${locationNames}。`,
    '- 睡眠项标 "kind": "sleep"，其余项省略 kind。',
    '- 符合你的身份、习惯与当前处境；参考你的记忆与目标安排要事。',
  ].join('\n')
  return {
    system: `${buildEngineSystem(ctx)}\n\n${instruction}`,
    user: `现在时间 ${ctx.snapshot.timeline.simNow}，请安排从此刻开始的日程。`,
  }
}

/** beat：日程项结束后的生活节拍 */
export function buildBeatPrompt(ctx: EngineContext, finishedItem: ScheduleItem | null, windowMinutes: number): PromptPair {
  const locationNames = ctx.snapshot.locations.map((l) => l.name).join('、')
  const windowDesc = finishedItem
    ? `你的日程项「${finishedItem.activity}」（@${finishedItem.location}，${finishedItem.start}-${finishedItem.end}）刚刚结束，回顾这约 ${windowMinutes} 分钟。`
    : `回顾刚刚过去的约 ${windowMinutes} 分钟。`
  const instruction = [
    '## 任务：生活节拍',
    windowDesc,
    '生成你这段时间的经历与内心。只输出一个 JSON 对象（不要任何其他文字，不要代码块）：',
    '{',
    '  "events": [{"title": "10 字以内标题", "description": "第一人称两三句话", "offsetMin": 距窗口起点的分钟数}],',
    '  "thought": "此刻的第一人称想法（你在想什么、为什么这么做）",',
    '  "memory": {"content": "值得长期记住的事", "type": "timeline | relationship | world", "importance": 1-10} 或 null,',
    '  "nextLocation": "要去的地点 或 null",',
    '  "nextActivity": "接下来做的事 或 null",',
    '  "mood": "情绪变化 或 null",',
    '  "goal": "目标变化 或 null"',
    '}',
    '要求：',
    '- events 1-2 条，覆盖这段时间的关键经历；平淡的日常也给 1 条，不要编造大事。',
    '- thought 必填，第一人称，与你刚才做的事直接相关。',
    '- memory 仅当发生了值得长期记住的事时给出（importance 7 以上意味着影响深远）；大多数节拍给 null。',
    `- nextLocation 必须是世界地点之一（${locationNames}）；不移动就给 null（将按你的日程继续）。`,
  ].join('\n')
  return {
    system: `${buildEngineSystem(ctx)}\n\n${instruction}`,
    user: `现在时间 ${ctx.snapshot.timeline.simNow}。开始生成。`,
  }
}

/** injection：注入事件的感知与反应（输出格式同 beat） */
export function buildInjectionPrompt(ctx: EngineContext, eventText: string): PromptPair {
  const base = buildBeatPrompt(ctx, null, 0)
  const injection = [
    '',
    '## 突发事件',
    '就在刚才，世界里发生了一件事：',
    `「${eventText}」`,
    '按你的性格与处境感知并反应它——你可以改变接下来的行动（nextLocation/nextActivity/mood/goal），',
    'events 中至少一条要是你对这件事的反应（offsetMin 给 0）。如果此事与你无关或你无从知晓，也应给出符合你状态的回应（thought 里体现你的不知情或漠然）。',
  ].join('\n')
  return { system: base.system + injection, user: base.user }
}

export interface DialogueTurnView {
  personName: string
  utterance: string
}

/** dialogue_turn：轮到某人发言 */
export function buildDialoguePrompt(
  ctx: EngineContext,
  othersNames: string[],
  turns: DialogueTurnView[],
  opts: { isLastTurn: boolean; location: string },
): PromptPair {
  const transcript = turns.length
    ? turns.map((t) => `${t.personName}：${t.utterance}`).join('\n')
    : '（对话刚刚开始，还没有人开口）'
  const instruction = [
    '## 任务：对话进行中',
    `你正在${opts.location}与${othersNames.join('、')}交谈。到目前为止的对话：`,
    transcript,
    '',
    '轮到你开口了。只输出一个 JSON 对象（不要任何其他文字，不要代码块）：',
    '{',
    '  "utterance": "你说的话（符合你的说话方式，一两句为宜）",',
    '  "thought": "你此刻的内心想法（第一人称，不会说出口）",',
    '  "shouldEnd": true 或 false,',
    '  "memory": {"content": "这段对话对你而言值得留下的事", "importance": 1-10} 或 null',
    '}',
    '要求：',
    '- 按你的性格决定说什么、说多少；可以提及你的记忆与秘密，但按你的分寸。',
    '- shouldEnd 仅当话题自然结束或你想告辞时为 true。',
    opts.isLastTurn
      ? '- 这是本轮对话的最后机会：必须为 memory 给出内容，总结这段对话对你意味着什么。'
      : '- memory 平时给 null；对话中真正触动了你时才给。',
  ].join('\n')
  return {
    system: `${buildEngineSystem(ctx)}\n\n${instruction}`,
    user: `现在时间 ${ctx.snapshot.timeline.simNow}。请开口。`,
  }
}

/** summary：把一批老记忆蒸馏为一条摘要 */
export function buildSummaryPrompt(ctx: EngineContext, batch: Memory[]): PromptPair {
  const list = batch
    .map((m) => `- ${m.simTime ? `[${m.simTime.slice(0, 16).replace('T', ' ')}] ` : ''}${m.content}`)
    .join('\n')
  const instruction = [
    '## 任务：整理记忆',
    '以下是你过去的一批记忆。把它们蒸馏成一段第三人称摘要：保留关键事实、涉及的人与情感转折，50-150 字。',
    '只输出一个 JSON 对象（不要任何其他文字，不要代码块）：',
    '{"content": "摘要", "importance": 1-10}',
    'importance 取这批记忆中最重要的那条应有的分值。',
  ].join('\n')
  return {
    system: `${buildEngineSystem(ctx)}\n\n${instruction}`,
    user: `待整理的记忆：\n${list}`,
  }
}
