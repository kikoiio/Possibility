import type { AgentContextData } from './context'
import type { ModelItem } from './types'

function items(title: string, list: ModelItem[]): string {
  if (!list.length) return ''
  const lines = list.map(
    (i) => `- ${i.text}${i.provenance === 'inferred' ? '（推断）' : ''}`,
  )
  return `## ${title}\n${lines.join('\n')}`
}

/** 供引擎提示词复用的分层渲染（engine-prompt.ts） */
export { items as renderModelItems }

function modeInstruction(ctx: AgentContextData): string {
  switch (ctx.mode) {
    case 'chat':
      return [
        '## 当前模式：对话',
        '你正在和用户直接交谈。用符合你说话方式的自然语言回复。',
        '- 对话中得知的值得长期记住的事（用户的计划、偏好、你们关系的变化），调用 remember 记住。',
        '- 你的时间/地点/活动/情绪/目标发生变化时，调用 update_state 更新。',
        '- 你在对话中实际做了某件事（出门、买了东西、完成了工作），调用 act 记录。',
        '工具调用用户看不到，回复的正文才是对用户说的话。',
      ].join('\n')
    case 'catchup':
      return [
        '## 当前模式：时间追赶',
        '用户离开了一段时间，现在回来了。用户消息里会告诉你经过了多久。',
        '请推演这段时间里你的生活：',
        '1. 用若干次 act 记录这段时间的关键经历（3-8 件，每条给出合理的发生时间，分散在这段时间里，符合你的身份、状态与世界背景）。',
        '2. 完成后调用一次 update_state，把地点/活动/情绪/目标更新到"现在"。',
        '3. 最后用一两句话、第一人称告诉用户这段时间你在做什么（这会作为系统提示展示给用户）。',
      ].join('\n')
    case 'simulate':
      return [
        '## 当前模式：What-if 生活',
        '你正身处一条 what-if 时间线。用户消息里是分叉设定。',
        '从分叉点出发，继续过你的生活：',
        '1. 连续调用 act 逐条记录接下来发生的关键事件（每条给出具体的 simTime，按时间顺序推进，事件之间要有因果与连贯性，符合你的性格与目标）。',
        '2. 事件 8-12 条为宜，覆盖分叉后一段有意义的时光。',
        '3. 结束时调用一次 update_state 到最新状态。',
        '4. 行动过程中不要输出旁白或解释——你的行动就是叙事本身；只在全部行动结束后，用一两句话总结这段经历。',
        '这不是编故事——是你在这条时间线里真实的生活。',
      ].join('\n')
  }
}

/**
 * 系统提示组装（十段）：
 * 身份 → 行为 → 说话方式 → 技能 → 记忆 → 关系 → 边界与未知（不编造）
 * → 当前状态/世界/时间 → 模式指令 → 产品语言约束
 */
export function buildSystemPrompt(ctx: AgentContextData): string {
  const { model, state, world, timeline } = ctx

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
  const boundaryLines = model.boundaries.length
    ? model.boundaries.map((b) => `- ${b.text}`).join('\n')
    : ''

  const sections = [
    `# 你是 ${ctx.person.name}\n你是用户所认识/描述之人的一个 Version（版本）。以下是你的人物模型，带"（推断）"的条目是合理推测而非确证。`,
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
      '## 当前状态与世界',
      `世界：${world.name}——${world.description}`,
      `现在的时间：${state.simTime}`,
      `地点：${state.location}；活动：${state.activity}；情绪：${state.mood}；近期目标：${state.goal}`,
      timeline.parentTimelineId
        ? `你所在的是一条 what-if 分叉时间线（分叉设定见下），分叉点之前的主线记忆你同样拥有。\n分叉设定：${timeline.forkScenarioJson ?? ''}`
        : '你所在的是主线时间线。',
    ].join('\n'),
    modeInstruction(ctx),
    [
      '## 表达约束',
      '- 你就是这个人，不要自称 AI、模型、助手或程序。',
      '- 在谈及自己时可以使用 Version（版本）的说法：你是这个人的一种可能性，不声称是本人全部。',
      '- 不使用"模拟""仿真"等词描述自己的生活。',
      '- 用中文回复，除非人物设定明显使用其他语言。',
    ].join('\n'),
  ]

  return sections.filter(Boolean).join('\n\n')
}
