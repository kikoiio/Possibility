import { describe, expect, it } from 'vitest'
import { detectPlatform, PlatformGate } from '../bridge/platform-gate'

describe('PlatformGate', () => {
  it('窄屏 → 移动端：只读，隐藏编辑入口（AC18）', () => {
    const gate = new PlatformGate((q) => q === '(max-width: 767px)')
    expect(gate.isMobile).toBe(true)
    expect(gate.canEdit()).toBe(false)
    expect(gate.showEditing).toBe(false)
  })

  it('粗指针（触屏）→ 移动端', () => {
    const gate = new PlatformGate((q) => q === '(pointer: coarse)')
    expect(gate.isMobile).toBe(true)
    expect(gate.canEdit()).toBe(false)
  })

  it('桌面 → 可编辑', () => {
    const gate = new PlatformGate(() => false)
    expect(gate.isMobile).toBe(false)
    expect(gate.canEdit()).toBe(true)
    expect(gate.showEditing).toBe(true)
  })

  it('detectPlatform 默认查询在无 window 环境下视为桌面', () => {
    expect(detectPlatform().isMobile).toBe(false)
  })
})
