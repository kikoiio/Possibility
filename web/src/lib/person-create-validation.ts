import type { ApiError } from '../api/client'
import type { DistillDraft } from '../api/types'

export type PersonCreateField = 'description' | 'name' | 'identity' | 'behavior' | 'speech' | 'boundaries' | 'unknowns'
export type FieldErrors = Partial<Record<PersonCreateField, string>>

export interface PersonCreateValidationState {
  fields: FieldErrors
  global: string
}

export const PERSON_CREATE_FIELD_ORDER: readonly PersonCreateField[] = [
  'name',
  'identity',
  'behavior',
  'speech',
  'boundaries',
  'unknowns',
]

const FIELD_LABELS: Record<PersonCreateField, string> = {
  description: '人物描述',
  name: '姓名',
  identity: '身份与价值观',
  behavior: '行为模式',
  speech: '说话方式',
  boundaries: '边界',
  unknowns: '未知事项',
}

function emptyState(): PersonCreateValidationState {
  return { fields: {}, global: '' }
}

function fieldFromText(text: string): PersonCreateField | null {
  const normalized = text.toLowerCase()
  if (normalized.includes('description') || text.includes('描述')) return 'description'
  if (normalized.includes('name') || text.includes('姓名')) return 'name'
  if (normalized.includes('identity') || text.includes('身份') || text.includes('价值观')) return 'identity'
  if (normalized.includes('behavior') || text.includes('行为')) return 'behavior'
  if (normalized.includes('speech') || text.includes('说话')) return 'speech'
  if (normalized.includes('boundar') || text.includes('边界')) return 'boundaries'
  if (normalized.includes('unknown') || text.includes('不知道') || text.includes('未知')) return 'unknowns'
  return null
}

export function validatePersonDraft(draft: DistillDraft, manual: boolean): PersonCreateValidationState {
  const state = emptyState()
  if (!draft.name.trim()) state.fields.name = '姓名不能为空。'
  if (manual) {
    const model = draft.model
    if (!model.identity.some(item => item.text.trim())) state.fields.identity = '请至少填写一条身份与价值观。'
    if (!model.behavior.some(item => item.text.trim())) state.fields.behavior = '请至少填写一条行为模式。'
    if (!model.speech.some(item => item.text.trim())) state.fields.speech = '请至少填写一条说话方式。'
    if (!model.boundaries.some(item => item.text.trim())) state.fields.boundaries = '请至少填写一条边界。'
    if (!model.unknowns.some(item => item.trim())) state.fields.unknowns = '请至少写下一项人物目前不知道的事。'
  }
  return state
}

export function normalizePersonCreateError(error: unknown, _context: 'distill' | 'save'): PersonCreateValidationState {
  const state = emptyState()
  const candidate = error as Partial<ApiError> | null
  const message = error instanceof Error
    ? error.message
    : typeof candidate?.message === 'string' ? candidate.message : ''
  const issues = Array.isArray(candidate?.issues) ? candidate.issues : []
  const entries = issues.length > 0 ? issues : [{ code: '', message }]

  for (const issue of entries) {
    const text = `${issue.code} ${issue.message}`.trim()
    const field = fieldFromText(text)
    if (field && !state.fields[field]) state.fields[field] = issue.message || `${FIELD_LABELS[field]}填写有误。`
  }
  const mapped = Object.keys(state.fields).length > 0
  state.global = mapped && entries.every(issue => fieldFromText(`${issue.code} ${issue.message}`.trim()))
    ? ''
    : message || '保存失败，请重试。'
  return state
}

export function focusFirstPersonCreateError(
  fieldOrder: readonly PersonCreateField[],
  errors: FieldErrors,
  elements: Partial<Record<PersonCreateField, HTMLElement | null>>,
): PersonCreateField | null {
  const field = fieldOrder.find(key => !!errors[key] && !!elements[key]) ?? null
  if (!field) return null
  const element = elements[field]
  element?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  element?.focus({ preventScroll: true })
  return field
}

export function fieldErrorId(field: PersonCreateField): string {
  return `person-create-error-${field}`
}
