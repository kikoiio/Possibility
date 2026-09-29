/** 平台闸门：移动端只读（F22）——隐藏全部编辑入口，保留观察与点击 */
export interface PlatformInfo {
  isMobile: boolean
  canEdit: boolean
}

export function detectPlatform(query?: (q: string) => boolean): PlatformInfo {
  const matches = query ?? ((q: string) => typeof window !== 'undefined' && window.matchMedia(q).matches)
  const isMobile = matches('(max-width: 767px)') || matches('(pointer: coarse)')
  return { isMobile, canEdit: !isMobile }
}

export class PlatformGate {
  private info: PlatformInfo

  constructor(query?: (q: string) => boolean) {
    this.info = detectPlatform(query)
  }

  get isMobile(): boolean {
    return this.info.isMobile
  }

  /** 传给 EditController 的 canEdit 闸门（F22, F18 产品侧） */
  canEdit = (): boolean => this.info.canEdit

  /** UI 侧：编辑入口是否渲染 */
  get showEditing(): boolean {
    return this.info.canEdit
  }
}
