import { validateKnowledgeChain } from '../agent/knowledge'
import type { ActionPlan } from '../world-state/rules'
import { environmentActionPlan, informActionPlan } from '../world-state/rules'
import type { WorldAction } from '../world-state/types'
import { WorldStateError as StateError } from '../world-state/types'
import type { worldFacts } from '../db/schema'

export type ForkInitialAction =
  | { type: 'inform'; recipientId: string; topic: string; content: string; sourceFactId?: string }
  | { type: 'environment'; location: string; condition: 'weather' | 'lighting' | 'access'; value: string }

export type ForkActionProposal = ForkInitialAction

export function forkActionSummary(action: WorldAction): string {
  if (action.type === 'inform') return '已向指定居民传递消息'
  if (action.type !== 'environment') return '已执行分叉初始动作'
  const condition = action.condition === 'weather' ? '天气'
    : action.condition === 'lighting' ? '照明' : '通行状态'
  return `${action.location}的${condition}已设为：${action.value}`
}

/** Normalize the client-owned action fields without accepting derived persistence fields. */
export function normalizeForkInitialAction(value: unknown): ForkInitialAction {
  const input = object(value)
  if (!input) invalid('分叉初始动作无效')
  if (input.type === 'environment') {
    if (input.condition !== 'weather' && input.condition !== 'lighting' && input.condition !== 'access') invalid('环境类别不受支持')
    if (typeof input.location !== 'string' || typeof input.value !== 'string') invalid('环境动作字段无效')
    return { type: 'environment', location: input.location.trim(), condition: input.condition, value: input.value.trim() }
  }
  if (input.type === 'inform') {
    if (typeof input.recipientId !== 'string' || typeof input.topic !== 'string' || typeof input.content !== 'string') invalid('消息动作字段无效')
    if (input.sourceFactId != null && typeof input.sourceFactId !== 'string') invalid('事实来源无效')
    const sourceFactId = typeof input.sourceFactId === 'string' ? input.sourceFactId.trim() : undefined
    if (input.sourceFactId != null && !sourceFactId) invalid('事实来源无效')
    return { type: 'inform', recipientId: input.recipientId.trim(), topic: input.topic.trim(), content: input.content.trim(),
      ...(sourceFactId ? { sourceFactId } : {}) }
  }
  return invalid('分叉初始动作类型不受支持')
}

/** Strictly parse the model draft; target membership and all execution rules are checked later. */
export function normalizeForkActionProposal(value: unknown): ForkActionProposal | null {
  const input = object(value)
  if (!input) return null
  if (input.type === 'inform') {
    return { type: 'inform', recipientId: typeof input.recipientId === 'string' ? input.recipientId.trim() : '',
      topic: typeof input.topic === 'string' ? input.topic.trim() : '',
      content: typeof input.content === 'string' ? input.content.trim() : '' }
  }
  if (input.type === 'environment'
    && (input.condition === 'weather' || input.condition === 'lighting' || input.condition === 'access')) {
    return { type: 'environment', location: typeof input.location === 'string' ? input.location.trim() : '',
      condition: input.condition, value: typeof input.value === 'string' ? input.value.trim() : '' }
  }
  return null
}

export interface PreparedForkAction {
  action: WorldAction
  plan: ActionPlan
  sourceChain: string[]
}

export interface ForkActionContext {
  recipientIds: ReadonlySet<string>
  locationNames: ReadonlySet<string>
  sourceFacts: (typeof worldFacts.$inferSelect)[]
  allowedTimelineIds: ReadonlySet<string>
  sourceTimelineId: string
  forkPointVersion: number
}

export interface ForkSourceCandidate {
  id: string
  type: 'knowledge' | 'environment' | 'location' | 'resident_state'
  simTime: string
  certainty: 'fact' | 'rumor'
  label: string
}

function invalid(message: string): never { throw new StateError(message, 400) }

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** Validate an untrusted client action and derive all persisted semantics on the server. */
export function prepareForkAction(value: unknown, context: ForkActionContext): PreparedForkAction {
  const input = normalizeForkInitialAction(value)

  if (input.type === 'environment') {
    const location = input.location
    const condition = input.condition
    const targetValue = input.value
    if (!location || !context.locationNames.has(location)) invalid('地点不属于这个世界')
    if (condition !== 'weather' && condition !== 'lighting' && condition !== 'access') invalid('环境类别不受支持')
    if (!targetValue || targetValue.length > 200) invalid('环境状态值必填且不得超过 200 字')
    const action: Extract<WorldAction, { type: 'environment' }> = { type: 'environment', location, condition, value: targetValue }
    return { action, plan: environmentActionPlan(action), sourceChain: [] }
  }

  if (input.type === 'inform') {
    const recipientId = input.recipientId
    const topic = input.topic
    const content = input.content
    if (!recipientId || !context.recipientIds.has(recipientId)) invalid('接收者不属于这个世界')
    if (!topic || topic.length > 80 || !content || content.length > 500) invalid('消息主题必填且不得超过 80 字，内容必填且不得超过 500 字')
    const sourceFactId = input.sourceFactId
    let certainty: 'fact' | 'rumor' = 'rumor'
    let sourceChain: string[] = []
    if (sourceFactId) {
      const source = context.sourceFacts.find(fact => fact.id === sourceFactId)
      if (!source) invalid('事实来源不在该分叉时刻可继承的证据中')
      let sourceValue: Record<string, unknown>
      try {
        const parsed = JSON.parse(source.valueJson) as unknown
        const parsedObject = object(parsed)
        if (!parsedObject) invalid('事实来源载荷无效')
        sourceValue = parsedObject
      } catch { invalid('事实来源载荷无效') }
      if (source.factType === 'knowledge' && source.visibility === 'private'
        && (sourceValue.certainty === 'fact' || sourceValue.certainty === 'rumor')) certainty = sourceValue.certainty
      else if (source.visibility === 'world' && ['environment', 'location', 'resident_state'].includes(source.factType)) certainty = 'fact'
      else invalid('该记录不能作为消息来源')

      const result = validateKnowledgeChain({ recipientId, topic, content, certainty, sourceFactId }, context.sourceFacts, {
        currentTimelineId: context.sourceTimelineId,
        currentVersion: context.forkPointVersion + 1,
        allowedTimelineIds: context.allowedTimelineIds,
      })
      if (!result.ok) invalid('消息来源不可继承或证据链无效')
      certainty = result.certainty
      sourceChain = result.sourceChain
    }
    const action: Extract<WorldAction, { type: 'inform' }> = {
      type: 'inform', recipientId, topic, content, ...(sourceFactId ? { sourceFactId } : {}),
    }
    return { action, plan: informActionPlan(action, certainty), sourceChain }
  }

  invalid('分叉初始动作类型不受支持')
}

/** Return only evidence that the source line can inherit at the selected fork point. */
export function forkSourceCandidates(
  facts: (typeof worldFacts.$inferSelect)[],
  allowedTimelineIds: ReadonlySet<string>,
  sourceTimelineId: string,
  forkPointVersion: number,
): ForkSourceCandidate[] {
  const candidates: ForkSourceCandidate[] = []
  for (const fact of facts) {
    if (!allowedTimelineIds.has(fact.timelineId)) continue
    let value: Record<string, unknown>
    try {
      const parsed = object(JSON.parse(fact.valueJson))
      if (!parsed) continue
      value = parsed
    } catch { continue }

    let certainty: 'fact' | 'rumor'
    let label: string
    if (fact.factType === 'knowledge' && fact.visibility === 'private'
      && typeof value.recipientId === 'string' && typeof value.topic === 'string'
      && typeof value.content === 'string' && (value.certainty === 'fact' || value.certainty === 'rumor')) {
      certainty = value.certainty
      label = `居民消息（${certainty === 'fact' ? '事实' : '传闻'}）`
    } else if (fact.visibility === 'world' && fact.factType === 'environment'
      && typeof value.condition === 'string' && typeof value.value === 'string') {
      certainty = 'fact'
      const conditionLabel = value.condition === 'weather' ? '天气'
        : value.condition === 'lighting' ? '照明' : value.condition === 'access' ? '通行状态' : value.condition
      label = `环境记录（${String(value.location ?? '全世界')}·${conditionLabel}）`
    } else if (fact.visibility === 'world' && fact.factType === 'location') {
      certainty = 'fact'
      label = '地点记录'
    } else if (fact.visibility === 'world' && fact.factType === 'resident_state') {
      certainty = 'fact'
      label = '居民状态记录'
    } else continue

    const result = validateKnowledgeChain({ recipientId: 'fork-preview', topic: '候选来源', content: '候选来源',
      certainty, sourceFactId: fact.id }, facts, {
      currentTimelineId: sourceTimelineId,
      currentVersion: forkPointVersion + 1,
      allowedTimelineIds,
    })
    if (!result.ok) continue
    candidates.push({ id: fact.id, type: fact.factType as ForkSourceCandidate['type'],
      simTime: fact.simTime, certainty: result.certainty, label })
  }
  return candidates.sort((a, b) => b.simTime.localeCompare(a.simTime) || a.id.localeCompare(b.id))
}
