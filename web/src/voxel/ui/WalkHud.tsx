// S2b 第一视角 HUD(F1/F4):模式切换按钮、准星、操作提示条、切换失败提示、室内天花板遮罩
export interface WalkHudProps {
  mode: 'orbit' | 'walk'
  onToggle(): void
  /** 切换失败原因(落点找不到等),短暂展示 */
  notice?: string | null
  /** 是否处于室内/天花板覆盖环境 (Phase 3) */
  isIndoor?: boolean
}

export default function WalkHud({ mode, onToggle, notice, isIndoor = false }: WalkHudProps) {
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        data-testid="voxel-mode-toggle"
        className="absolute right-3 top-28 z-10 rounded-full bg-zinc-900/70 px-3 py-1.5 text-xs text-zinc-100 shadow ring-1 ring-zinc-700 hover:bg-zinc-800"
      >
        {mode === 'orbit' ? '🚶 进入第一视角' : '🗺 返回上帝视角'}
      </button>
      {notice && (
        <div
          className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full bg-amber-900/80 px-4 py-1.5 text-xs text-amber-100"
          data-testid="voxel-mode-notice"
        >
          {notice}
        </div>
      )}
      {mode === 'walk' && (
        <>
          {/* 室内第一视角天花板遮罩 (Phase 3) */}
          {isIndoor && (
            <div
              className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-black/60 via-black/25 to-transparent transition-opacity duration-300"
              data-testid="voxel-ceiling-mask"
            />
          )}
          {/* 准星(F4:屏幕中心射线选中) */}
          <div className="pointer-events-none absolute inset-0 grid place-items-center" data-testid="voxel-crosshair">
            <div className="h-3 w-3 rounded-full border border-white/80 bg-white/20" />
          </div>
          <div
            className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-zinc-900/70 px-4 py-1.5 text-xs text-zinc-200"
            data-testid="voxel-walk-hint"
          >
            WASD 移动 · 空格跳跃 · 双击空格飞行 · Esc 释放鼠标 · V 返回上帝视角
          </div>
        </>
      )}
    </>
  )
}
