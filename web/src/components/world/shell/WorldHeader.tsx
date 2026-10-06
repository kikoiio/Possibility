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

  return (
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="text-xs uppercase tracking-[.16em] text-[#849183]">
          {world.name}
          {world.isDemo ? ' · 演示世界' : ''}
        </p>
        <h1 className="font-story text-xl text-[#2d4435]">
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
          className="max-w-44 rounded-full border border-[#d7ded3] bg-white/90 px-3 py-2 text-xs text-[#536558]"
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
            className="rounded-full border border-[#d7ded3] bg-white/85 px-4 py-2 text-xs text-[#536558]"
          >
            {regeneratingDemo ? '重新生成中…' : '重新生成演示世界'}
          </button>
        )}

        {canInteract && (
          <button
            onClick={onToggleInject}
            className="rounded-full border border-[#d7ded3] bg-white/85 px-4 py-2 text-xs text-[#536558]"
          >
            干预
          </button>
        )}

        {canInteract && (
          <button
            onClick={onOpenPresence}
            className="rounded-full border border-[#d7ded3] bg-white/85 px-4 py-2 text-xs text-[#536558]"
          >
            在场
          </button>
        )}

        <button
          onClick={onOpenLife}
          className="rounded-full border border-[#d7ded3] bg-white/85 px-4 py-2 text-xs text-[#536558]"
        >
          你不在时
        </button>

        {timelines.length > 1 && (
          <button
            onClick={onOpenCompare}
            className="rounded-full border border-[#d7ded3] bg-white/85 px-4 py-2 text-xs text-[#536558]"
          >
            对照宇宙
          </button>
        )}

        <button
          onClick={onToggleLlmConfig}
          className="rounded-full border border-[#d7ded3] bg-white/85 px-4 py-2 text-xs text-[#536558]"
        >
          LLM
        </button>

        {(running || !evidenceReadonly) && (
          <button
            onClick={onPauseResume}
            className="rounded-full border border-[#d7ded3] bg-white/85 px-4 py-2 text-xs text-[#536558]"
          >
            {running ? '暂停' : '继续'}
          </button>
        )}

        <button
          onClick={onOpenHistory}
          className="rounded-full border border-[#d7ded3] bg-white/85 px-4 py-2 text-xs text-[#536558]"
        >
          历史
        </button>

        {!guest && (
          <button
            data-testid="scene-check-entry"
            onClick={onOpenCompatibility}
            className="rounded-full border border-[#d7ded3] bg-white/85 px-4 py-2 text-xs text-[#536558]"
          >
            场景检查
          </button>
        )}

        <button
          onClick={() => navigate('/settings')}
          className="rounded-full border border-[#d7ded3] bg-white/85 px-4 py-2 text-xs text-[#536558]"
        >
          设置
        </button>

        <button
          onClick={onArchiveWorld}
          className="rounded-full border border-[#d7ded3] bg-white/85 px-3 py-2 text-xs text-[#849184]"
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
          className="rounded-full border border-[#d7ded3] bg-white/85 px-3 py-2 text-xs text-[#536558]"
        >
          退出
        </button>
      </div>
    </header>
  )
}
