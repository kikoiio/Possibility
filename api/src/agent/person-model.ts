import type { ModelItem, PersonModel, Provenance } from './types'

const MODEL_LAYERS = [
  'identity',
  'behavior',
  'speech',
  'skills',
  'memories',
  'relationships',
  'boundaries',
] as const

function normalizeItems(value: unknown): ModelItem[] {
  if (!Array.isArray(value)) return []
  const items: ModelItem[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      const text = item.trim()
      if (text) items.push({ text, provenance: 'inferred' })
      continue
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue

    const record = item as { text?: unknown; provenance?: unknown }
    const text = String(record.text ?? '').trim()
    if (!text) continue
    const provenance: Provenance = record.provenance === 'known' ? 'known' : 'inferred'
    items.push({ text, provenance })
  }
  return items
}

function normalizeUnknowns(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
}

/** Converts stored or generated data to the current person model shape. */
export function normalizePersonModel(value: unknown): PersonModel {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const model = Object.fromEntries(MODEL_LAYERS.map((key) => [key, normalizeItems(record[key])])) as Pick<PersonModel, (typeof MODEL_LAYERS)[number]>
  return { ...model, unknowns: normalizeUnknowns(record.unknowns) }
}
