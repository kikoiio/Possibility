import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DistillDraft } from '../api/types'
import PersonCard from './PersonCard'

function draft(): DistillDraft {
  return {
    name: '林岚',
    model: {
      identity: [
        { text: '经营一家书店', provenance: 'known' },
        { text: '喜欢夜间散步', provenance: 'inferred' },
      ],
      behavior: [],
      speech: [],
      skills: [],
      memories: [],
      relationships: [],
      boundaries: [],
      unknowns: [],
    },
    worldName: '旧城',
    worldDescription: '一座安静的城市',
    initialState: { location: '', activity: '', mood: '', goal: '' },
  }
}

function findElement(node: ReactNode, predicate: (element: ReactElement) => boolean): ReactElement | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate)
      if (found) return found
    }
    return undefined
  }
  if (!isValidElement(node)) return undefined
  if (predicate(node)) return node
  if (typeof node.type === 'function') {
    return findElement((node.type as (props: unknown) => ReactNode)(node.props), predicate)
  }
  return findElement((node.props as { children?: ReactNode }).children, predicate)
}

describe('PersonCard provenance', () => {
  it('renders existing known and inferred labels', () => {
    const html = renderToStaticMarkup(PersonCard({ draft: draft() }))

    expect(html).toContain('确知')
    expect(html).toContain('推断')
    expect(html).toContain('经营一家书店')
    expect(html).toContain('喜欢夜间散步')
  })

  it('adds a new model item as known', () => {
    const currentDraft = draft()
    let changedDraft: DistillDraft | undefined
    const tree = PersonCard({ draft: currentDraft, onChange: next => { changedDraft = next } })
    const addButton = findElement(tree, element =>
      element.type === 'button' && (element.props as { children?: ReactNode }).children === '+ 添加一条',
    )

    expect(addButton).toBeDefined()
    const onClick = (addButton?.props as { onClick?: () => void } | undefined)?.onClick
    onClick?.()

    expect(changedDraft?.model.identity.at(-1)).toEqual({ text: '', provenance: 'known' })
  })

  it('confirms, edits, deletes, and keeps unknowns in their own field', () => {
    let currentDraft = draft()
    currentDraft.model.unknowns = ['尚未确认的来历']
    const render = () => PersonCard({ draft: currentDraft, onChange: next => { currentDraft = next } })
    const inferredBadge = findElement(render(), element =>
      element.type === 'button' && (element.props as { children?: ReactNode }).children === '推断',
    )
    ;(inferredBadge?.props as { onClick?: () => void } | undefined)?.onClick?.()
    expect(currentDraft.model.identity[1].provenance).toBe('known')

    const identityInput = findElement(render(), element =>
      element.type === 'input' && (element.props as { id?: string }).id === 'person-create-identity-0',
    )
    ;(identityInput?.props as { onChange?: (event: unknown) => void } | undefined)?.onChange?.({
      target: { value: '修改后的身份' },
    })
    expect(currentDraft.model.identity[0].text).toBe('修改后的身份')

    const unknownInput = findElement(render(), element =>
      element.type === 'input' && (element.props as { id?: string }).id === 'person-create-unknowns-0',
    )
    ;(unknownInput?.props as { onChange?: (event: unknown) => void } | undefined)?.onChange?.({
      target: { value: '仍不知道的来历' },
    })
    expect(currentDraft.model.unknowns).toEqual(['仍不知道的来历'])

    const deleteButton = findElement(render(), element =>
      element.type === 'button' && (element.props as { 'aria-label'?: string })['aria-label'] === '删除',
    )
    ;(deleteButton?.props as { onClick?: () => void } | undefined)?.onClick?.()
    expect(currentDraft.model.identity).toEqual([{ text: '喜欢夜间散步', provenance: 'known' }])
  })
})
