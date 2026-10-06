/**
 * Browser-side view of the finite environment projection produced by the API.
 *
 * This module deliberately accepts the DTO structurally so the web package does
 * not import server code. It does not infer new values from prose: unsupported
 * conditions and values are dropped before they reach a renderer.
 */

export type EnvironmentCondition = 'weather' | 'lighting' | 'access'
export type EnvironmentValue =
  | 'clear' | 'rain' | 'fog'
  | 'day' | 'dusk' | 'night'
  | 'open' | 'closed'

export interface EnvironmentProjectionItem {
  readonly location: string
  readonly condition: EnvironmentCondition
  readonly value: EnvironmentValue
  readonly label: string
}
export type EnvironmentBucket = Record<EnvironmentCondition, EnvironmentProjectionItem | null>

export interface TimelineEnvironmentProjection {
  readonly world: EnvironmentBucket
  readonly locations: Readonly<Record<string, EnvironmentBucket>>
}

const CONDITIONS: readonly EnvironmentCondition[] = ['weather', 'lighting', 'access']
const VALUES: Readonly<Record<EnvironmentCondition, readonly EnvironmentValue[]>> = {
  weather: ['clear', 'rain', 'fog'],
  lighting: ['day', 'dusk', 'night'],
  access: ['open', 'closed'],
}
const LABELS: Readonly<Record<EnvironmentValue, string>> = {
  clear: '晴朗', rain: '降雨', fog: '雾',
  day: '白昼', dusk: '黄昏', night: '黑夜',
  open: '开放', closed: '封闭',
}
const CONDITION_LABELS: Readonly<Record<EnvironmentCondition, string>> = {
  weather: '天气', lighting: '光照', access: '通行状态',
}

function emptyBucket(): EnvironmentBucket {
  return { weather: null, lighting: null, access: null }
}

function isCondition(value: unknown): value is EnvironmentCondition {
  return typeof value === 'string' && (CONDITIONS as readonly string[]).includes(value.trim().toLowerCase())
}

function normalizeValue(condition: EnvironmentCondition, value: unknown): EnvironmentValue | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return (VALUES[condition] as readonly string[]).includes(normalized)
    ? normalized as EnvironmentValue : null
}

function itemFromRecord(value: unknown): EnvironmentProjectionItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (!isCondition(record.condition)) return null
  const condition = record.condition.trim().toLowerCase() as EnvironmentCondition
  const kind = normalizeValue(condition, record.value)
  if (!kind) return null
  const location = typeof record.location === 'string' && record.location.trim()
    ? record.location.trim() : 'world'
  return { location, condition, value: kind, label: LABELS[kind] }
}

/** Project raw fact values into the same finite shape as the API DTO. */
export function projectEnvironmentFacts(
  facts: Iterable<{ value: unknown; condition?: unknown; factType?: unknown }>,
): TimelineEnvironmentProjection {
  const result: { world: EnvironmentBucket; locations: Record<string, EnvironmentBucket> } = {
    world: emptyBucket(), locations: {},
  }
  for (const fact of facts) {
    if (fact.factType !== undefined && fact.factType !== 'environment') continue
    // A few legacy snapshots kept condition beside value. Supporting that
    // transport shape does not widen the accepted enum vocabulary.
    const raw = fact.value && typeof fact.value === 'object' && !Array.isArray(fact.value)
      ? { ...(fact.value as Record<string, unknown>), condition: (fact.value as Record<string, unknown>).condition ?? fact.condition }
      : { condition: fact.condition, value: fact.value }
    const item = itemFromRecord(raw)
    if (!item) continue
    const bucket = item.location === 'world'
      ? result.world
      : (result.locations[item.location] ??= emptyBucket())
    bucket[item.condition] = item
  }
  return result
}

export function environmentValueLabel(value: EnvironmentValue): string {
  return LABELS[value]
}

export function environmentConditionLabel(condition: EnvironmentCondition): string {
  return CONDITION_LABELS[condition]
}

export function firstEnvironmentValue(
  projection: TimelineEnvironmentProjection,
  condition: EnvironmentCondition,
): EnvironmentProjectionItem | null {
  if (projection.world[condition]) return projection.world[condition]
  for (const bucket of Object.values(projection.locations)) {
    if (bucket[condition]) return bucket[condition]
  }
  return null
}

export interface EnvironmentLocationVisual {
  readonly locationName: string
  readonly visualState: string
}

/** Stable text projection used by the life overlay and 2D labels. */
export function environmentLocationVisuals(
  projection: TimelineEnvironmentProjection,
): EnvironmentLocationVisual[] {
  const values: EnvironmentLocationVisual[] = []
  const append = (locationName: string, bucket: EnvironmentBucket): void => {
    for (const condition of CONDITIONS) {
      const item = bucket[condition]
      if (item) values.push({
        locationName,
        visualState: `${CONDITION_LABELS[condition]}: ${item.label}`,
      })
    }
  }
  append('世界', projection.world)
  for (const [location, bucket] of Object.entries(projection.locations)) append(location, bucket)
  return values
}
