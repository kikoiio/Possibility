import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { TimelineComparison, TimelineInfo, WorldEventItem, WorldSnapshot } from '../../../api/types'
import { formatWorldTime } from '../../../lib/world-time'
import type { OrbitPose } from '../../../voxel/engine'
import type { VoxelDocument } from '@possibility/voxel-contract'
import type { SceneLifeOverlay } from '@possibility/scene-contract'
import VoxelViewport from '../../../voxel/VoxelViewport'
import { timelineDisplayName } from '../../../world/timeline-display'
import AlignedTimeline from '../AlignedTimeline'
import type { buildAlignedAxis, AxisMarker } from '../../../world/alignedTimeline'

export interface SplitViewStageProps {
  isSmall: boolean
  snapshot: WorldSnapshot
  otherSnapshot: WorldSnapshot | null
  voxelDoc: VoxelDocument
  overlay: SceneLifeOverlay | null
  otherOverlay: SceneLifeOverlay | null
  personNames: Record<string, string>
  sharedPose: OrbitPose | null
  setSharedPose: (pose: OrbitPose) => void
  linkActive: boolean
  cameraLinked: boolean
  setCameraLinked: (linked: boolean) => void
  splitWalk: { left: boolean; right: boolean }
  setSplitWalk: Dispatch<SetStateAction<{ left: boolean; right: boolean }>>
  rightTimelineId: string | null
  setRightTimelineId: (id: string) => void
  rightSceneRead: { status: 'closed' | 'idle' | 'loading' | 'ready' | 'error'; message?: string }
  retryRightScene: () => void
  swapSplit: () => void
  closeSplit: (side: 'left' | 'right') => void
  scrubAt: string | null
  setScrubAt: (at: string | null) => void
  axis: ReturnType<typeof buildAlignedAxis> | null
  handleSelectMarker: (marker: AxisMarker) => void
  compareSummary: { facts: number; states: number; events: number } | null
  comparisonRead: { status: 'closed' | 'idle' | 'loading' | 'ready' | 'error'; message?: string }
  retryComparison: () => void
  alignedComparison: TimelineComparison | null
  comparison: TimelineComparison | null
  smallSide: 'left' | 'right'
  setSmallSide: Dispatch<SetStateAction<'left' | 'right'>>
  selectedSplitEvent: string | null
  splitEventEls: MutableRefObject<Map<string, HTMLElement>>
  splitEvents: (side: 'left' | 'right', snap: WorldSnapshot | null) => WorldEventItem[]
}

export default function SplitViewStage({
  isSmall,
  snapshot,
  otherSnapshot,
  voxelDoc,
  overlay,
  otherOverlay,
  personNames,
  sharedPose,
  setSharedPose,
  linkActive,
  cameraLinked,
  setCameraLinked,
  splitWalk,
  setSplitWalk,
  rightTimelineId,
  setRightTimelineId,
  rightSceneRead,
  retryRightScene,
  swapSplit,
  closeSplit,
  scrubAt,
  setScrubAt,
  axis,
  handleSelectMarker,
  compareSummary,
  comparisonRead,
  retryComparison,
  alignedComparison,
  comparison,
  smallSide,
  setSmallSide,
  selectedSplitEvent,
  splitEventEls,
  splitEvents,
}: SplitViewStageProps) {
  const sideInfo = (snap: WorldSnapshot | null): TimelineInfo | null =>
    snap ? snap.timelines.find(t => t.id === snap.currentTimelineId) ?? null : null

  const renderSplitSideHeader = (side: 'left' | 'right', snap: WorldSnapshot | null) => {
    const info = sideInfo(snap)
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <p className="font-medium text-[#405447]" data-testid={`split-title-${side}`}>
          {side === 'left' ? '原来的发展' : '另一种发展'} · {info ? (info.parentTimelineId ? '分叉' : '主线') : '…'}
          {info?.forkScenario?.whatIf ? (
            <span className="ml-1 font-normal text-[#687a6b]">如果{info.forkScenario.whatIf}</span>
          ) : null}
        </p>
        <div className="flex items-center gap-2">
          {scrubAt && snap && scrubAt < snap.simNow && (
            <span
              data-testid={`split-current-badge-${side}`}
              className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-800"
            >
              视口为当前状态
            </span>
          )}
          <span data-testid={`split-clock-${side}`} className="text-[#849184]">
            {snap ? formatWorldTime(snap.simNow, snap.world.timeZone) : '读取中…'}
          </span>
          <button
            type="button"
            data-testid={`split-close-${side}`}
            onClick={() => closeSplit(side)}
            className="rounded-full border border-[#d7ded3] bg-white px-2 py-0.5 text-[10px] text-[#536558]"
          >
            关闭分屏
          </button>
        </div>
      </div>
    )
  }

  const renderSplitEvents = (side: 'left' | 'right', snap: WorldSnapshot | null) => {
    const items = splitEvents(side, snap)
    return (
      <ul
        data-testid={`split-events-${side}`}
        className="max-h-28 space-y-1 overflow-y-auto rounded-xl bg-white/70 px-3 py-2 text-[11px] text-[#526558]"
      >
        {items.length === 0 && <li className="text-[#849184]">这段时间没有已记录的事件。</li>}
        {items.map(event => {
          const key = `${side}:${event.id}`
          return (
            <li
              key={event.id}
              ref={el => {
                if (el) splitEventEls.current.set(key, el)
                else splitEventEls.current.delete(key)
              }}
              data-testid="split-event"
              data-event-id={event.id}
              className={`rounded px-1 py-0.5 ${selectedSplitEvent === key ? 'bg-amber-100' : ''}`}
            >
              <span className="font-medium">{event.title}</span>
              <span className="ml-1 text-[#849184]">
                {formatWorldTime(event.simTime, side === 'left' ? snapshot.world.timeZone : otherSnapshot?.world.timeZone)}
              </span>
            </li>
          )
        })}
      </ul>
    )
  }

  if (isSmall) {
    const snap = smallSide === 'left' ? snapshot : otherSnapshot
    const info = sideInfo(snap)
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="split-small">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <p className="font-medium text-[#405447]" data-testid="split-small-title">
            {smallSide === 'left' ? '原来的发展' : '另一种发展'} · {info ? (info.parentTimelineId ? '分叉' : '主线') : '…'}
            <span className="ml-1 font-normal text-[#849184]">
              {snap ? formatWorldTime(snap.simNow, snap.world.timeZone) : '读取中…'}
            </span>
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="split-small-toggle"
              onClick={() => setSmallSide(s => (s === 'left' ? 'right' : 'left'))}
              className="rounded-full border border-[#d7ded3] bg-white px-3 py-1.5 text-[10px] text-[#536558]"
            >
              看{smallSide === 'left' ? '另一种' : '原来的'}发展
            </button>
            <button
              type="button"
              data-testid="split-close-small"
              onClick={() => closeSplit(smallSide)}
              className="rounded-full border border-[#d7ded3] bg-white px-3 py-1.5 text-[10px] text-[#536558]"
            >
              关闭分屏
            </button>
          </div>
        </div>
        {snap ? (
          <VoxelViewport
            document={voxelDoc}
            overlay={smallSide === 'left' ? overlay : otherOverlay}
            events={(smallSide === 'left' ? snapshot.voxelEvents : otherSnapshot?.voxelEvents) ?? null}
            timeZone={snap.world.timeZone}
            instanceId={smallSide === 'left' ? 'left' : 'right'}
            probePrimary={smallSide === 'left'}
            personNames={personNames}
          />
        ) : rightSceneRead.status === 'error' ? (
          <div
            role="alert"
            data-testid="split-right-error"
            className="grid min-h-[430px] place-content-center gap-3 rounded-2xl bg-white/60 p-4 text-center text-sm text-[#718075]"
          >
            <p>{rightSceneRead.message}</p>
            <button
              type="button"
              data-testid="split-right-retry"
              onClick={retryRightScene}
              className="mx-auto rounded-full border border-[#d7ded3] bg-white px-4 py-2 text-xs text-[#536558]"
            >
              重试读取右侧
            </button>
          </div>
        ) : (
          <div
            role="status"
            data-testid="split-right-loading"
            className="grid min-h-[430px] place-items-center rounded-2xl bg-white/60 text-sm text-[#718075]"
          >
            正在读取另一种发展…
          </div>
        )}
        {comparisonRead.status === 'loading' && (
          <p role="status" data-testid="split-compare-loading" className="text-xs text-[#718075]">
            正在读取时间线对照…
          </p>
        )}
        {comparisonRead.status === 'error' && (
          <div
            role="alert"
            data-testid="split-compare-error"
            className="flex flex-wrap items-center gap-3 rounded-xl bg-white/80 px-3 py-2 text-xs text-[#718075]"
          >
            <span>{comparisonRead.message}</span>
            <button
              type="button"
              data-testid="split-compare-retry"
              onClick={retryComparison}
              className="rounded-full border border-[#d7ded3] bg-white px-3 py-1.5 text-[#536558]"
            >
              重试对照
            </button>
          </div>
        )}
        <p className="text-[10px] text-[#849184]">窄屏仅显示单视口；大屏可同时分屏查看两条时间线。</p>
      </div>
    )
  }

  const rightChoices = snapshot.timelines.filter(t => t.id !== snapshot.currentTimelineId)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="split-view">
      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-2">
        <section className="flex min-h-0 flex-col gap-2" data-testid="split-left">
          {renderSplitSideHeader('left', snapshot)}
          <div className="min-h-0 flex-1">
            <VoxelViewport
              document={voxelDoc}
              overlay={overlay}
              events={snapshot.voxelEvents ?? null}
              personNames={personNames}
              timeZone={snapshot.world.timeZone}
              instanceId="left"
              probePrimary
              fitContainer
              cameraPose={linkActive ? sharedPose : undefined}
              onCameraChange={setSharedPose}
              onCameraModeChange={m => setSplitWalk(s => ({ ...s, left: m === 'walk' }))}
            />
          </div>
          {renderSplitEvents('left', snapshot)}
        </section>

        <section className="flex min-h-0 flex-col gap-2" data-testid="split-right">
          {renderSplitSideHeader('right', otherSnapshot)}
          <div className="flex items-center gap-2 text-xs">
            <select
              aria-label="右侧时间线"
              data-testid="split-right-selector"
              value={otherSnapshot?.currentTimelineId ?? rightTimelineId ?? ''}
              onChange={e => setRightTimelineId(e.target.value)}
              className="max-w-64 rounded-full border border-[#d7ded3] bg-white/90 px-3 py-1.5 text-xs text-[#536558]"
            >
              {rightChoices.map(t => (
                <option key={t.id} value={t.id}>
                  {timelineDisplayName(t)} · {formatWorldTime(t.simNow, t.timeZone)}
                  {t.forkScenario?.whatIf ? ` · 如果${t.forkScenario.whatIf}` : ''}
                </option>
              ))}
            </select>
            <button
              type="button"
              data-testid="split-swap"
              onClick={swapSplit}
              disabled={!otherSnapshot}
              className="rounded-full border border-[#d7ded3] bg-white px-3 py-1.5 text-[10px] text-[#536558] disabled:opacity-50"
            >
              ⇄ 互换左右
            </button>
          </div>
          <div className="min-h-0 flex-1">
            {otherSnapshot ? (
              <VoxelViewport
                document={voxelDoc}
                overlay={otherOverlay}
                events={otherSnapshot.voxelEvents ?? null}
                personNames={personNames}
                timeZone={otherSnapshot.world.timeZone}
                instanceId="right"
                fitContainer
                cameraPose={linkActive ? sharedPose : undefined}
                onCameraChange={setSharedPose}
                onCameraModeChange={m => setSplitWalk(s => ({ ...s, right: m === 'walk' }))}
              />
            ) : rightSceneRead.status === 'error' ? (
              <div
                role="alert"
                data-testid="split-right-error"
                className="grid h-full min-h-0 place-content-center gap-3 rounded-2xl bg-white/60 p-4 text-center text-sm text-[#718075]"
              >
                <p>{rightSceneRead.message}</p>
                <button
                  type="button"
                  data-testid="split-right-retry"
                  onClick={retryRightScene}
                  className="mx-auto rounded-full border border-[#d7ded3] bg-white px-4 py-2 text-xs text-[#536558]"
                >
                  重试读取右侧
                </button>
              </div>
            ) : (
              <div
                role="status"
                data-testid="split-right-loading"
                className="grid h-full min-h-0 place-items-center rounded-2xl bg-white/60 text-sm text-[#718075]"
              >
                正在读取另一种发展…
              </div>
            )}
          </div>
          {renderSplitEvents('right', otherSnapshot)}
        </section>
      </div>

      {axis && (
        <AlignedTimeline
          axis={axis}
          leftTimeZone={
            snapshot.timelines.find(t => t.id === snapshot.currentTimelineId)?.timeZone ??
            snapshot.world.timeZone ??
            'UTC'
          }
          rightTimeZone={
            otherSnapshot?.timelines.find(t => t.id === otherSnapshot.currentTimelineId)?.timeZone ??
            otherSnapshot?.world.timeZone ??
            snapshot.world.timeZone ??
            'UTC'
          }
          at={scrubAt}
          onScrub={setScrubAt}
          onSelect={handleSelectMarker}
        />
      )}

      {compareSummary && (
        <p className="text-xs text-[#687a6b]" data-testid="split-compare-summary">
          已有记录：{compareSummary.facts} 项事实差异、{compareSummary.states} 组人物状态差异、{compareSummary.events} 条分支独有事件。场景布局相同；画面只显示各自时间线已记录的生活状态。
        </p>
      )}

      {comparisonRead.status === 'loading' && (
        <p role="status" data-testid="split-compare-loading" className="text-xs text-[#718075]">
          正在读取时间线对照…
        </p>
      )}

      {comparisonRead.status === 'error' && (
        <div
          role="alert"
          data-testid="split-compare-error"
          className="flex flex-wrap items-center gap-3 rounded-xl bg-white/80 px-3 py-2 text-xs text-[#718075]"
        >
          <span>{comparisonRead.message}</span>
          <button
            type="button"
            data-testid="split-compare-retry"
            onClick={retryComparison}
            className="rounded-full border border-[#d7ded3] bg-white px-3 py-1.5 text-[#536558]"
          >
            重试对照
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-white/70 px-3 py-2 text-xs text-[#526558]">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            data-testid="split-camera-link"
            checked={cameraLinked}
            onChange={e => setCameraLinked(e.target.checked)}
          />
          相机联动
        </label>
        {(splitWalk.left || splitWalk.right) && (
          <span data-testid="split-walk-notice" className="text-amber-700">
            第一视角下相机联动已暂停（两线的「我」不在同一位置）
          </span>
        )}
        <span className="text-[#849184]">联动开启时，一侧的旋转/缩放/平移同步到另一侧</span>
      </div>

      {(alignedComparison ?? comparison) && (alignedComparison ?? comparison)!.limitations.length > 0 && (
        <ul data-testid="split-limitations" className="space-y-0.5 text-[10px] text-[#849184]">
          {(alignedComparison ?? comparison)!.limitations.map((x, i) => (
            <li key={i}>· {x}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
