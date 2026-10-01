import type { AccessContext } from './types'

export interface WorldCapabilities {
  observe: boolean
  participate: boolean
  editScene: boolean
  fork: boolean
  compare: boolean
  persist: boolean
  resetDemo: boolean
}

const NONE: WorldCapabilities = { observe: false, participate: false, editScene: false, fork: false, compare: false, persist: false, resetDemo: false }

export function capabilitiesFor(access: AccessContext, scope: { isPublicBaseline: boolean; ownsWorld: boolean; adminDemoOwner?: boolean }): WorldCapabilities {
  // 公共演示基线：只有管理员物主可编辑场景，模拟与访客能力仍冻结。
  if (scope.isPublicBaseline) {
    if (scope.adminDemoOwner) return { ...NONE, observe: true, editScene: true }
    return { ...NONE, observe: true }
  }
  if (!scope.ownsWorld) return NONE
  if (access.kind === 'guest') return { observe: true, participate: true, editScene: false, fork: true, compare: true, persist: false, resetDemo: true }
  if (access.kind === 'user') return { observe: true, participate: true, editScene: true, fork: true, compare: true, persist: true, resetDemo: false }
  return NONE
}

export function assertBaselineWritable(isPublicBaseline: boolean): void {
  if (isPublicBaseline) throw new Error('公共演示基线只读')
}
