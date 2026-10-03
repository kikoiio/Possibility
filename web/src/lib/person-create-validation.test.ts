import { describe, expect, it, vi } from 'vitest'
import {
  PERSON_CREATE_FIELD_ORDER,
  focusFirstPersonCreateError,
  normalizePersonCreateError,
  validatePersonDraft,
} from './person-create-validation'
import type { DistillDraft } from '../api/types'

const draft = (overrides: Partial<DistillDraft> = {}): DistillDraft => ({
  name: '林岚',
  model: {
    identity: [{ text: '店主', provenance: 'known' }],
    behavior: [{ text: '观察', provenance: 'known' }],
    speech: [{ text: '温和', provenance: 'known' }],
    skills: [], memories: [], relationships: [],
    boundaries: [{ text: '不代替他人做决定', provenance: 'known' }],
    unknowns: ['过去的秘密'],
  }, worldName: '', worldDescription: '',
  initialState: { location: '', activity: '', mood: '', goal: '' },
  ...overrides,
})

describe('person-create-validation', () => {
  it('returns stable field errors for an empty manual draft', () => {
    const result = validatePersonDraft(draft({ name: ' ', model: { ...draft().model, identity: [], behavior: [], speech: [], boundaries: [], unknowns: [] } }), true)
    expect(result.fields).toEqual({
      name: '姓名不能为空。',
      identity: '请至少填写一条身份与价值观。',
      behavior: '请至少填写一条行为模式。',
      speech: '请至少填写一条说话方式。',
      boundaries: '请至少填写一条边界。',
      unknowns: '请至少写下一项人物目前不知道的事。',
    })
  })

  it('does not require manual-only fields for generated drafts', () => {
    expect(validatePersonDraft(draft({ name: ' ' }), false).fields).toEqual({ name: '姓名不能为空。' })
  })

  it('maps known server issues and preserves unknown failures globally', () => {
    const result = normalizePersonCreateError({ message: '姓名有误', issues: [{ code: 'name_required', message: '姓名不能为空' }, { code: 'server', message: '服务暂不可用' }] }, 'save')
    expect(result.fields).toEqual({ name: '姓名不能为空' })
    expect(result.global).toBe('姓名有误')
  })

  it('focuses the first available field in the declared order', () => {
    const focus = vi.fn()
    const scroll = vi.fn()
    const result = focusFirstPersonCreateError(PERSON_CREATE_FIELD_ORDER, { unknowns: 'x', name: 'x' }, {
      name: { focus, scrollIntoView: scroll } as unknown as HTMLElement,
    })
    expect(result).toBe('name')
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
  })
})
