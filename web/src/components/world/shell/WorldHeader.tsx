import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { clearToken } from '../../../api/client'
import type {
  ForkInitialAction,
  ForkScenario,
  ForkScenarioInput,
  HistoryRange,
  TimelineInfo,
  WorldSnapshot,
} from '../../../api/types'
import TimelineSwitcher from '../TimelineSwitcher'
import Drawer from '../../ui/Drawer'

export interface WorldHeaderProps {
  worldId: string
  world: WorldSnapshot['world']
  timelines: TimelineInfo[]
  mode: 'observe' | 'life' | 'possibility'
  worldChoices: { id: string; name: string; hasScene: boolean; personNames?: string[]; status?: string }[]
  activeTimelineId: string
  evidenceReadonly: boolean
  running: boolean
  canInteract: boolean
  canEditScene: boolean
  voxelSpaces: boolean
  guest?: boolean
  regeneratingDemo: boolean
  historyRange?: HistoryRange
  forkPrefill: { key: string; whatIf: string; simTime: string } | null
  sceneHistoryOpen: boolean
  onSwitchTimeline: (timelineId: string) => void
  onForkTimeline: (scenario: ForkScenarioInput, f1?: { expectedSourceVersion: number; initialAction: ForkInitialAction }) => Promise<boolean>
  onPreviewFork: (whatIf: string, startTime?: string) => Promise<ForkScenario>
  onArchiveTimeline: (timelineId: string) => void
  onSplitView: () => void
  onForkOpen?: () => void
  onCheckMoment?: (at: string) => Promise<string>
  onRegenerateDemo: () => void
  onToggleInject: () => void
  onOpenPresence: () => void
  onOpenLife: () => void
  onOpenCompare: () => void
  onToggleLlmConfig: () => void
  onPauseResume: () => void
  onOpenHistory: () => void
  onOpenCompatibility: () => void
  onArchiveWorld: () => void
}

export default function WorldHeader({
  worldId,
  world,
  timelines,
  mode,
  worldChoices,
  activeTimelineId,
  evidenceReadonly,
  running,
  canInteract,
  canEditScene,
  voxelSpaces,
  guest,
  regeneratingDemo,
  historyRange,
  forkPrefill,
  sceneHistoryOpen: _sceneHistoryOpen,
  onSwitchTimeline,
  onForkTimeline,
  onPreviewFork,
  onArchiveTimeline,
  onSplitView,
  onForkOpen,
  onCheckMoment,
  onRegenerateDemo,
  onToggleInject,
  onOpenPresence,
  onOpenLife,
  onOpenCompare,
  onToggleLlmConfig,
  onPauseResume,
  onOpenHistory,
  onOpenCompatibility,
  onArchiveWorld,
}: WorldHeaderProps) {
  const navigate = useNavigate()
  const [settingsOpen, setSettingsOpen] = useState(false)

  return (
    <>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[.16em] text-ink-faint">
            {world.name}
            {world.isDemo ? ' · 演示世界' : ''}
          </p>
          <h1 className="font-story text-xl text-sage-800">
            {mode === 'possibility' ? '另一种可能' : '这里正在生活'}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="map-world-switcher">
            切换世界
          </label>
          <select
            id="map-world-switcher"
            aria-label="切换世界"
            value={worldId}
            onChange={event => {
              const selectedWorld = worldChoices.find(w => w.id === event.target.value)
              if (event.target.value === '__new__') navigate('/worlds/new')
              else if (selectedWorld?.hasScene) navigate(`/worlds/${encodeURIComponent(event.target.value)}`)
            }}
            className="max-w-44 rounded-full border border-ink-line/80 bg-sheet/90 px-3 py-2 text-xs text-ink-soft backdrop-blur-sm"
          >
            {worldChoices.map(w => (
              <option
                key={w.id}
                value={w.id}
                disabled={!w.hasScene}
                title={!w.hasScene ? '该世界待创建场景，当前无法进入。' : undefined}
              >
                {w.name}
                {w.hasScene ? '' : ' · 待创建场景'}
              </option>
            ))}
            <option value="__new__">＋ 创建世界</option>
          </select>

          <TimelineSwitcher
            timelines={timelines}
            currentTimelineId={activeTimelineId}
            onSwitch={onSwitchTimeline}
            onFork={onForkTimeline}
            onPreview={onPreviewFork}
            onArchive={onArchiveTimeline}
            writeLocked={evidenceReadonly}
            onSplitView={onSplitView}
            historyRange={historyRange}
            onForkOpen={onForkOpen}
            onCheckMoment={onCheckMoment}
            forkPrefill={forkPrefill}
          />

          {canEditScene && world.isDemo && voxelSpaces && (
            <button
              data-testid="demo-regenerate"
              disabled={regeneratingDemo}
              onClick={onRegenerateDemo}
              className="rounded-full border border-ink-line/80 bg-sheet/85 px-4 py-2 text-xs text-ink-soft backdrop-blur-sm transition hover:bg-sheet hover:text-ink"
            >
              {regeneratingDemo ? '重新生成中…' : '重新生成演示世界'}
            </button>
          )}

          {canInteract && (
            <button
              onClick={onToggleInject}
              className="rounded-full border border-ink-line/80 bg-sheet/85 px-4 py-2 text-xs text-ink-soft backdrop-blur-sm transition hover:bg-sheet hover:text-ink"
            >
              干预
            </button>
          )}

          {canInteract && (
            <button
              onClick={onOpenPresence}
              className="rounded-full border border-ink-line/80 bg-sheet/85 px-4 py-2 text-xs text-ink-soft backdrop-blur-sm transition hover:bg-sheet hover:text-ink"
            >
              在场
            </button>
          )}

          <button
            onClick={onOpenLife}
            className="rounded-full border border-ink-line/80 bg-sheet/85 px-4 py-2 text-xs text-ink-soft backdrop-blur-sm transition hover:bg-sheet hover:text-ink"
          >
            你不在时
          </button>

          {timelines.length > 1 && (
            <button
              onClick={onOpenCompare}
              className="rounded-full border border-ink-line/80 bg-sheet/85 px-4 py-2 text-xs text-ink-soft backdrop-blur-sm transition hover:bg-sheet hover:text-ink"
            >
              对照宇宙
            </button>
          )}

          <button
            onClick={onToggleLlmConfig}
            className="rounded-full border border-ink-line/80 bg-sheet/85 px-4 py-2 text-xs text-ink-soft backdrop-blur-sm transition hover:bg-sheet hover:text-ink"
          >
            LLM
          </button>

          {(running || !evidenceReadonly) && (
            <button
              onClick={onPauseResume}
              className="rounded-full border border-ink-line/80 bg-sheet/85 px-4 py-2 text-xs text-ink-soft backdrop-blur-sm transition hover:bg-sheet hover:text-ink"
            >
              {running ? '暂停' : '继续'}
            </button>
          )}

          <button
            onClick={onOpenHistory}
            className="rounded-full border border-ink-line/80 bg-sheet/85 px-4 py-2 text-xs text-ink-soft backdrop-blur-sm transition hover:bg-sheet hover:text-ink"
          >
            历史
          </button>

          {!guest && (
            <button
              data-testid="scene-check-entry"
              onClick={onOpenCompatibility}
              className="rounded-full border border-ink-line/80 bg-sheet/85 px-4 py-2 text-xs text-ink-soft backdrop-blur-sm transition hover:bg-sheet hover:text-ink"
            >
              场景检查
            </button>
          )}

          <button
            type="button"
            aria-label="设置"
            title="设置与世界管理"
            onClick={() => setSettingsOpen(true)}
            className="rounded-full border border-ink-line/80 bg-sheet/85 px-4 py-2 text-xs text-ink-soft backdrop-blur-sm transition hover:bg-sheet hover:text-ink"
          >
            设置
          </button>

          <button
            onClick={onArchiveWorld}
            className="hidden sm:inline-flex rounded-full border border-ink-line/80 bg-sheet/85 px-3 py-2 text-xs text-ink-faint backdrop-blur-sm transition hover:bg-sheet hover:text-ink-soft"
          >
            归档
          </button>

          <button
            aria-label="退出登录"
            title="退出登录"
            onClick={() => {
              clearToken()
              navigate('/login', { replace: true })
            }}
            className="hidden sm:inline-flex rounded-full border border-ink-line/80 bg-sheet/85 px-3 py-2 text-xs text-ink-soft backdrop-blur-sm transition hover:bg-sheet hover:text-ink"
          >
            退出
          </button>
        </div>
      </header>

      <Drawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="设置与世界管理"
        description={`${world.name} · ${world.isDemo ? '演示世界' : '所有者管理'}`}
      >
        <div className="space-y-4 text-xs text-ink-soft">
          <div className="rounded-xl border border-ink-line bg-sheet p-3 space-y-2">
            <h3 className="font-medium text-ink">世界控制</h3>
            <button
              type="button"
              onClick={() => {
                setSettingsOpen(false)
                navigate('/settings')
              }}
              className="block w-full rounded-lg px-3 py-2.5 text-left text-xs font-medium text-ink hover:bg-paper-deep transition"
            >
              ⚙️ LLM 设置与日预算
            </button>
            <button
              type="button"
              onClick={() => {
                setSettingsOpen(false)
                onArchiveWorld()
              }}
              className="block w-full rounded-lg px-3 py-2.5 text-left text-xs font-medium text-ink-soft hover:bg-paper-deep transition"
            >
              🗄️ 归档当前世界
            </button>
          </div>
          <div className="rounded-xl border border-ink-line bg-sheet p-3">
            <button
              type="button"
              aria-label="退出登录"
              title="退出登录"
              onClick={() => {
                setSettingsOpen(false)
                clearToken()
                navigate('/login', { replace: true })
              }}
              className="block w-full rounded-lg px-3 py-2.5 text-left text-xs font-medium text-cinnabar hover:bg-cinnabar-soft transition"
            >
              🚪 退出登录
            </button>
          </div>
        </div>
      </Drawer>
    </>
  )
}

