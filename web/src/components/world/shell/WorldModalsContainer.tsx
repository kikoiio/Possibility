import type { ReactNode } from 'react'
import type { ForkResult, WorldSnapshot } from '../../../api/types'
import { SceneHistoryPanel, type SceneHistoryViewState } from '../../scene/SceneHistoryPanel'
import WorldLlmConfigPanel from '../../WorldLlmConfigPanel'
import ComparePanel from '../ComparePanel'
import ForkCompareHint from '../ForkCompareHint'
import InjectBox from '../InjectBox'
import LifePanel from '../LifePanel'
import ScenePanel from '../ScenePanel'

export interface WorldModalsContainerProps {
  worldId: string
  snapshot: WorldSnapshot
  activeTimelineId: string
  personNames: Record<string, string>
  canInteract: boolean
  guest?: boolean
  // Scene history
  sceneHistoryState: { status: 'closed' } | SceneHistoryViewState
  restoringRevision: boolean
  restoreError: string
  onRestoreRevision: (version: number) => Promise<void>
  onRetryRevisionList: () => Promise<void>
  onCloseSceneHistory: () => void
  // Compatibility
  compatPanel?: ReactNode
  // LLM Config
  llmConfigOpen: boolean
  // Fork hint
  forkHint: (ForkResult & { sourceId: string; newId: string }) | null
  forkRefreshError: string
  onRefreshForkResult?: (fork: ForkResult & { sourceId: string; newId: string }) => Promise<unknown>
  onDismissForkHint: () => void
  // Inject
  injectOpen: boolean
  onInject: (instruction: string, requestId: string) => Promise<void>
  // Life
  lifeOpen: boolean
  onCloseLife: () => void
  onForkAtMoment: (simTime: string, premise: string) => void
  // Compare
  compareOpen: boolean
  compareInitial: { left?: string; right?: string } | null
  onOpenCompareFromHint?: () => void
  onCloseCompare: () => void
  loadComparison?: (left: string, right: string) => Promise<unknown>
  // Presence
  presenceOpen: boolean
  presenceLocation: string | null
  onClosePresence: () => void
}

export default function WorldModalsContainer({
  worldId,
  snapshot,
  activeTimelineId,
  personNames,
  canInteract,
  guest,
  sceneHistoryState,
  restoringRevision,
  restoreError,
  onRestoreRevision,
  onRetryRevisionList,
  onCloseSceneHistory,
  compatPanel,
  llmConfigOpen,
  forkHint,
  forkRefreshError,
  onRefreshForkResult,
  onDismissForkHint,
  injectOpen,
  onInject,
  lifeOpen,
  onCloseLife,
  onForkAtMoment,
  compareOpen,
  compareInitial,
  onOpenCompareFromHint,
  onCloseCompare,
  loadComparison,
  presenceOpen,
  presenceLocation,
  onClosePresence,
}: WorldModalsContainerProps) {
  return (
    <>
      {sceneHistoryState.status !== 'closed' && (
        <SceneHistoryPanel
          state={sceneHistoryState}
          restoring={restoringRevision}
          restoreError={restoreError}
          onRestore={(version: number) => void onRestoreRevision(version)}
          onRetry={() => void onRetryRevisionList()}
          onClose={onCloseSceneHistory}
        />
      )}

      {compatPanel}

      {llmConfigOpen && <WorldLlmConfigPanel worldId={worldId} />}

      {forkHint && !guest && (
        <ForkCompareHint
          worldId={worldId}
          sourceId={forkHint.sourceId}
          newId={forkHint.newId}
          name={forkHint.name}
          whatIf={forkHint.whatIf}
          actionSummary={forkHint.action?.summary}
          refreshError={forkRefreshError}
          onRetry={onRefreshForkResult ? () => void onRefreshForkResult(forkHint) : undefined}
          onCompare={onOpenCompareFromHint}
          onDismiss={onDismissForkHint}
        />
      )}

      {forkHint && (
        <p role="status" className="text-xs text-ink-soft sm:hidden">
          已创建分支「{forkHint.name}」：{forkHint.whatIf}
          {forkHint.action?.summary && ` · 已执行：${forkHint.action.summary}`}
          {forkRefreshError && onRefreshForkResult && (
            <button onClick={() => void onRefreshForkResult(forkHint)}>重试刷新</button>
          )}
          {!forkRefreshError && onOpenCompareFromHint && (
            <button onClick={onOpenCompareFromHint}>比较本次分支</button>
          )}
        </p>
      )}

      {injectOpen && canInteract && (
        <div className="rounded-2xl bg-white/85 px-4 py-3" data-testid="inject-overlay">
          <p className="mb-2 text-xs text-[#849184]">
            叙事干预会写入当前宇宙历史，并由居民在后续生活中自行感知和回应；它不等同于直接改变环境事实。
          </p>
          <InjectBox onInject={onInject} />
        </div>
      )}

      {lifeOpen && activeTimelineId && (
        <LifePanel
          worldId={worldId}
          timelineId={activeTimelineId}
          timeZone={snapshot.world.timeZone}
          onClose={onCloseLife}
          onForkAtMoment={onForkAtMoment}
        />
      )}

      {compareOpen && activeTimelineId && snapshot.timelines.length > 1 && (
        <ComparePanel
          worldId={worldId}
          currentTimelineId={activeTimelineId}
          timelines={snapshot.timelines}
          personNames={personNames}
          initialLeftTimelineId={compareInitial?.left}
          initialRightTimelineId={compareInitial?.right}
          loadComparison={loadComparison}
          onClose={onCloseCompare}
        />
      )}

      {presenceOpen && activeTimelineId && (
        <ScenePanel
          key={`${worldId}:${activeTimelineId}`}
          worldId={worldId}
          timelineId={activeTimelineId}
          timeZone={snapshot.world.timeZone}
          worldStatus={snapshot.world.status}
          readOnly={snapshot.evidence.level !== 'complete'}
          locations={snapshot.world.locations}
          initialLocation={presenceLocation ?? ''}
          onClose={onClosePresence}
        />
      )}
    </>
  )
}
