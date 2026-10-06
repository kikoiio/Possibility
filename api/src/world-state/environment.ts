/**
 * Finite environment vocabulary used by world actions and their projections.
 *
 * These values are intentionally closed. Arbitrary prose never becomes a new
 * environment state.
 */
export type EnvironmentCondition = 'weather' | 'lighting' | 'access'
export type EnvironmentValueKind =
  | 'clear' | 'rain' | 'fog'
  | 'day' | 'dusk' | 'night'
  | 'open' | 'closed'

export interface EnvironmentOption {
  value: EnvironmentValueKind
  label: string
}

export const ENVIRONMENT_CONDITIONS = ['weather', 'lighting', 'access'] as const

export const ENVIRONMENT_VALUE_OPTIONS: Record<EnvironmentCondition, readonly EnvironmentOption[]> = {
  weather: [
    { value: 'clear', label: '晴朗' },
    { value: 'rain', label: '降雨' },
    { value: 'fog', label: '雾' },
  ],
  lighting: [
    { value: 'day', label: '白昼' },
    { value: 'dusk', label: '黄昏' },
    { value: 'night', label: '黑夜' },
  ],
  access: [
    { value: 'open', label: '开放' },
    { value: 'closed', label: '封闭' },
  ],
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase()
}

export function normalizeEnvironmentCondition(value: string): EnvironmentCondition | null {
  const normalized = normalizeText(value)
  return (ENVIRONMENT_CONDITIONS as readonly string[]).includes(normalized)
    ? normalized as EnvironmentCondition : null
}

/** Return the canonical enum value, or null for an unsupported value. */
export function normalizeEnvironmentValue(
  condition: string,
  value: string,
): EnvironmentValueKind | null {
  const normalized = normalizeText(value)
  const normalizedCondition = normalizeEnvironmentCondition(condition)
  if (!normalizedCondition) return null
  return ENVIRONMENT_VALUE_OPTIONS[normalizedCondition]
    .some(option => option.value === normalized)
    ? normalized as EnvironmentValueKind : null
}

export function environmentLabel(condition: EnvironmentCondition): string {
  return condition === 'weather' ? '天气' : condition === 'lighting' ? '光照' : '通行状态'
}

export function environmentValueLabel(condition: EnvironmentCondition, value: EnvironmentValueKind): string {
  return ENVIRONMENT_VALUE_OPTIONS[condition].find(option => option.value === value)?.label ?? value
}

export interface EnvironmentProjectionDTO {
  location: string
  condition: EnvironmentCondition
  value: EnvironmentValueKind
  label: string
}

/** Short alias retained for callers that consume the per-condition DTO directly. */
export type EnvironmentProjection = EnvironmentProjectionDTO

export type EnvironmentBucket = Record<EnvironmentCondition, EnvironmentProjectionDTO | null>

/** Unified environment projection shape consumed by state/snapshot adapters. */
export interface TimelineEnvironmentProjection {
  world: EnvironmentBucket
  locations: Record<string, EnvironmentBucket>
}

function emptyBucket(): EnvironmentBucket {
  return { weather: null, lighting: null, access: null }
}

function projectionFromRecord(
  projection: TimelineEnvironmentProjection,
  value: Record<string, unknown>,
): void {
  if (typeof value.condition !== 'string' || typeof value.value !== 'string') return
  const condition = normalizeEnvironmentCondition(value.condition)
  if (!condition) return
  const kind = normalizeEnvironmentValue(condition, value.value)
  if (!kind) return
  const location = typeof value.location === 'string' && value.location.trim() ? value.location.trim() : null
  const target = location
    ? (projection.locations[location] ??= emptyBucket())
    : projection.world
  target[condition] = {
    location: location ?? 'world', condition, value: kind,
    label: environmentValueLabel(condition, kind),
  }
}

/** Project serialized world facts into the single finite environment DTO. */
export function projectEnvironment(
  facts: Iterable<{ subjectId: string; valueJson: string }>,
): TimelineEnvironmentProjection {
  const projection: TimelineEnvironmentProjection = { world: emptyBucket(), locations: {} }
  for (const fact of facts) {
    let value: Record<string, unknown>
    try {
      const parsed = JSON.parse(fact.valueJson) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      value = parsed as Record<string, unknown>
    } catch { continue }
    projectionFromRecord(projection, value)
  }
  return projection
}

/** Project already parsed current-fact values into the same DTO. */
export function projectEnvironmentValues(
  facts: Iterable<{ subjectId: string; value: unknown }>,
): TimelineEnvironmentProjection {
  const projection: TimelineEnvironmentProjection = { world: emptyBucket(), locations: {} }
  for (const fact of facts) {
    if (!fact.value || typeof fact.value !== 'object' || Array.isArray(fact.value)) continue
    projectionFromRecord(projection, fact.value as Record<string, unknown>)
  }
  return projection
}

export function accessBlocked(projection: TimelineEnvironmentProjection, location: string): boolean {
  return projection.locations[location]?.access?.value === 'closed'
}
