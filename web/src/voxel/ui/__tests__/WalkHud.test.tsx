import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import WalkHud from '../WalkHud'

describe('WalkHud (Phase 3)', () => {
  it('室内第一视角时渲染天花板遮罩', () => {
    const html = renderToStaticMarkup(createElement(WalkHud, { mode: 'walk', onToggle: () => {}, isIndoor: true }))
    expect(html).toContain('data-testid="voxel-ceiling-mask"')
    expect(html).toContain('data-testid="voxel-crosshair"')
  })

  it('室外第一视角时不渲染天花板遮罩', () => {
    const html = renderToStaticMarkup(createElement(WalkHud, { mode: 'walk', onToggle: () => {}, isIndoor: false }))
    expect(html).not.toContain('data-testid="voxel-ceiling-mask"')
    expect(html).toContain('data-testid="voxel-crosshair"')
  })

  it('上帝视角时不渲染天花板遮罩与准星', () => {
    const html = renderToStaticMarkup(createElement(WalkHud, { mode: 'orbit', onToggle: () => {}, isIndoor: true }))
    expect(html).not.toContain('data-testid="voxel-ceiling-mask"')
    expect(html).not.toContain('data-testid="voxel-crosshair"')
  })
})
