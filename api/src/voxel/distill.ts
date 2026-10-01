import type { EventImportance, VoxelCoord, WorldEvent, WorldEventType } from '@possibility/voxel-contract'

/**
 * S4 世界模拟 · 事件蒸馏(机械层,零 LLM)。
 * life 事件 → 聚簇(时间×地点×参与者)→ type 映射 → importance 评分 → timeWindow 推导
 * → WorldEvent + sourceEventIds 证据链。
 *
 * 纯函数纪律(同 S3b 生成器):时间全部来自入参,禁 Date.now/Math.random;
 * 同一输入恒得同一输出(e2e stub 下截图基线可复现)。
 */

/** life events 行的最小形状(蒸馏不依赖 db schema,便于单测) */
export interface DistillSourceEvent {
  id: string
  simTime: string
  // action / dialogue / injected / system
  kind: string
  title: string
  description: string
  actorPersonId: string | null
  dialogueId: string | null
}

export interface DistillDialogue {
  id: string
  location: string
  participantIds: string[]
}

export interface DistillInput {
  events: DistillSourceEvent[]
  dialogues: DistillDialogue[]
  /** 非对话事件的地点近似:行动者当前所在地点(谦逊纪律:不冒充历史精确位置) */
  actorLocation: (personId: string) => string | null
  /** 地点名 → 体素坐标(世界文档 locations 绑定解析;无法解析 = null) */
  resolveLocation: (name: string) => VoxelCoord | null
}

export interface DistilledVoxelEvent {
  event: WorldEvent
  sourceEventIds: string[]
}

export interface DistillResult {
  distilled: DistilledVoxelEvent[]
  /** 地点无法锚定到体素坐标而被跳过的事件数(诊断用,不算错误) */
  skipped: number
}

/** 非对话事件的聚簇时间桶(世界时):同参与者同地点同桶 = 同一事件簇 */
const CLUSTER_BUCKET_MS = 4 * 60 * 60 * 1000
/** 单事件簇的最小时间窗(契约要求 start < end) */
const MIN_WINDOW_MS = 30 * 60 * 1000

interface Cluster {
  key: string
  events: DistillSourceEvent[]
  location: string | null
  participantIds: string[]
  dialogueTurns: number
  hasInjected: boolean
}

function clusterOf(event: DistillSourceEvent, input: DistillInput, dialogues: Map<string, DistillDialogue>): Cluster | null {
  if (event.kind === 'system') return null
  if (event.dialogueId) {
    const dialogue = dialogues.get(event.dialogueId)
    return {
      key: `dlg:${event.dialogueId}`,
      events: [],
      location: dialogue?.location ?? null,
      participantIds: dialogue?.participantIds ?? (event.actorPersonId ? [event.actorPersonId] : []),
      dialogueTurns: 0,
      hasInjected: false,
    }
  }
  const location = event.actorPersonId ? input.actorLocation(event.actorPersonId) : null
  const bucket = Math.floor(Date.parse(event.simTime) / CLUSTER_BUCKET_MS)
  return {
    key: `solo:${event.actorPersonId ?? 'none'}:${location ?? ''}:${bucket}`,
    events: [],
    location,
    participantIds: event.actorPersonId ? [event.actorPersonId] : [],
    dialogueTurns: 0,
    hasInjected: event.kind === 'injected',
  }
}

/** importance 评分:参与者数 / 对话轮数 / 事件类型权重(纯函数) */
export function scoreImportance(cluster: Pick<Cluster, 'participantIds' | 'dialogueTurns' | 'hasInjected' | 'events'>): EventImportance {
  let score = 0
  if (cluster.participantIds.length >= 3) score += 2
  else if (cluster.participantIds.length === 2) score += 1
  if (cluster.dialogueTurns >= 4) score += 2
  else if (cluster.dialogueTurns >= 2) score += 1
  if (cluster.hasInjected) score += 2
  if (cluster.events.length >= 3) score += 1
  if (score >= 4) return 'high'
  if (score >= 2) return 'medium'
  return 'low'
}

/** type 映射:注入变故 → turning;多人高重要度 → celebration;其余 → daily */
export function mapEventType(cluster: Pick<Cluster, 'participantIds' | 'hasInjected'>, importance: EventImportance): WorldEventType {
  if (cluster.hasInjected) return 'turning'
  if (cluster.participantIds.length >= 3 && importance === 'high') return 'celebration'
  return 'daily'
}

/** 确定性模板文案(low 恒走模板;medium+ 在 LLM 失败/触顶时的兜底,fail-closed 不丢事件) */
export function templateCopy(cluster: Cluster, type: WorldEventType): Pick<WorldEvent, 'label' | 'teaser' | 'scene'> {
  const first = cluster.events[0]
  const label = cluster.dialogueTurns > 0 ? '交谈'
    : cluster.hasInjected ? '变故'
      : (first.title.trim().slice(0, 4) || { celebration: '庆典', daily: '日常', turning: '转折' }[type])
  const teaser = first.title.trim().slice(0, 40)
  const scene = cluster.events
    .map(event => (event.description.trim() ? `${event.title}——${event.description}` : event.title))
    .join('\n')
    .slice(0, 500)
  return { label, teaser, scene }
}

/**
 * 蒸馏主入口:life 事件集 → 体素事件集。
 * 地点无法锚定的簇跳过(计入 skipped);空输入 → 空产出。
 */
export function distillVoxelEvents(input: DistillInput): DistillResult {
  const dialogues = new Map(input.dialogues.map(dialogue => [dialogue.id, dialogue]))
  const clusters = new Map<string, Cluster>()
  const sorted = [...input.events].sort((a, b) => a.simTime.localeCompare(b.simTime) || a.id.localeCompare(b.id))
  for (const event of sorted) {
    const cluster = clusterOf(event, input, dialogues)
    if (!cluster) continue
    const existing = clusters.get(cluster.key)
    if (existing) {
      existing.events.push(event)
      if (event.kind === 'dialogue') existing.dialogueTurns += 1
      if (event.kind === 'injected') existing.hasInjected = true
      if (event.actorPersonId && !existing.participantIds.includes(event.actorPersonId)) {
        existing.participantIds.push(event.actorPersonId)
      }
    } else {
      cluster.events.push(event)
      if (event.kind === 'dialogue') cluster.dialogueTurns += 1
      clusters.set(cluster.key, cluster)
    }
  }

  const distilled: DistilledVoxelEvent[] = []
  let skipped = 0
  for (const cluster of clusters.values()) {
    const at = cluster.location ? input.resolveLocation(cluster.location) : null
    if (!at) {
      skipped += cluster.events.length
      continue
    }
    const importance = scoreImportance(cluster)
    const type = mapEventType(cluster, importance)
    const start = Date.parse(cluster.events[0].simTime)
    const last = Date.parse(cluster.events[cluster.events.length - 1].simTime)
    const timeWindow = {
      start: cluster.events[0].simTime,
      end: new Date(Math.max(last, start + MIN_WINDOW_MS)).toISOString(),
    }
    distilled.push({
      event: {
        id: cluster.key,
        type,
        at,
        importance,
        timeWindow,
        ...templateCopy(cluster, type),
        ...(cluster.participantIds.length > 0 ? { participants: [...cluster.participantIds].sort() } : {}),
      },
      sourceEventIds: cluster.events.map(event => event.id),
    })
  }
  distilled.sort((a, b) => a.event.timeWindow.start.localeCompare(b.event.timeWindow.start) || a.event.id.localeCompare(b.event.id))
  return { distilled, skipped }
}
