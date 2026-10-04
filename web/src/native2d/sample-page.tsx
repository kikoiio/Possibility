import { useEffect, useMemo, useRef, useState } from 'react'
import Native2dViewport from './Native2dViewport'
import { createSampleController, type SampleControllerState } from './controller'
import { FIXTURE_IDS } from './fixtures'
import { HALL_SPACE_ID, MIST_MANOR_SCENE } from './scene'
import { createLayoutRepository } from './storage'
import { createWorldSource } from './world-source'
import type { Native2dViewport as Native2dViewportApi, Selection, SourceConfig } from './types'
import './sample.css'

const FIXTURE_LABELS: Record<string, string> = {
  'mist-manor-day': '白昼快照',
  'mist-manor-night': '夜间快照',
  'mist-manor-refresh': '地点变化快照',
  'mist-manor-overcrowded': '大厅多人快照',
  'mist-manor-unknown-time': '未知时间快照',
  'public-mist-manor-day': '公开范围固定快照',
}
const BUILDING_LABELS: Record<string, string> = { 'main-house': '主楼', greenhouse: '温室', gatehouse: '门房' }

function initialState(): SampleControllerState {
  return {
    readState: { status: 'loading', lastGood: null, errorMessage: null, receivedAt: null },
    sourceConfig: null, spaceId: MIST_MANOR_SCENE.defaultSpaceId, presentation: null, layout: null,
    selection: null, follow: null, restore: { status: 'ok' }, save: { status: 'clean' }, moveMode: null,
    movePreview: null, canUndo: false, pendingReset: null, notice: null,
  }
}

export default function Native2dSamplePage() {
  const viewportRef = useRef<Native2dViewportApi | null>(null)
  const viewportBridge = useMemo<Native2dViewportApi>(() => ({
    setPresentation: (value) => viewportRef.current?.setPresentation(value),
    setSelection: (value) => viewportRef.current?.setSelection(value),
    setFollow: (value) => viewportRef.current?.setFollow(value),
    setMovePreview: (value) => viewportRef.current?.setMovePreview(value),
    setMoveMode: (buildingId) => viewportRef.current?.setMoveMode?.(buildingId),
    showOverview: () => viewportRef.current?.showOverview(),
    retryAssets: () => viewportRef.current?.retryAssets?.(),
    dispose: () => undefined,
  }), [])
  const controller = useMemo(() => createSampleController({
    scene: MIST_MANOR_SCENE,
    createSource: (config) => createWorldSource(config, MIST_MANOR_SCENE),
    repository: createLayoutRepository(MIST_MANOR_SCENE, () => window.localStorage),
    viewport: viewportBridge,
  }), [viewportBridge])
  const [state, setState] = useState<SampleControllerState>(initialState)
  const [sourceKind, setSourceKind] = useState<'fixture' | 'public'>('fixture')
  const [fixtureId, setFixtureId] = useState<string>(FIXTURE_IDS[0])
  const [buildingId, setBuildingId] = useState(MIST_MANOR_SCENE.buildings[0].id)
  const [overviewRequest, setOverviewRequest] = useState(0)
  const [infoOpen, setInfoOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)

  const lifecycleRef = useRef(0)

  useEffect(() => {
    const generation = lifecycleRef.current + 1
    lifecycleRef.current = generation
    const unsubscribe = controller.subscribe(() => setState(controller.getState()))
    controller.selectSource({ kind: 'fixture', fixtureId: FIXTURE_IDS[0] })
    setState(controller.getState())
    return () => {
      unsubscribe()
      // StrictMode replays setup immediately after cleanup; defer disposal so
      // that replay can retain the controller while real unmount still cleans it.
      queueMicrotask(() => {
        if (lifecycleRef.current === generation) controller.dispose()
      })
    }
  }, [controller])

  const world = state.readState.lastGood
  const currentSource: SourceConfig | null = state.sourceConfig
  const isHall = state.spaceId === HALL_SPACE_ID
  const selection = state.selection
  const selectedResident = selection?.kind === 'resident'
    ? world?.residents.find((resident) => resident.personId === selection.personId) ?? null : null
  const selectedLocation = selection?.kind === 'location'
    ? state.presentation?.locations.find((location) => location.locationKey === selection.locationKey) ?? null : null
  const selectedBuilding = selection?.kind === 'building'
    ? MIST_MANOR_SCENE.buildings.find((building) => building.id === selection.buildingId) ?? null : null
  const readBusy = state.readState.status === 'loading'
  const editBlocked = !world || isHall || state.restore.status === 'pending'
  const applySource = () => controller.selectSource(sourceKind === 'fixture' ? { kind: 'fixture', fixtureId } : { kind: 'public' })
  const selectObject = (selection: Selection) => { controller.select(selection); setInfoOpen(true) }
  const residentAtSelection = selectedLocation && world ? world.residents.filter((resident) => resident.locationName === selectedLocation.name) : []

  return (
    <main className="native2d-page" data-testid="native2d-sample">
      <header className="native2d-topbar">
        <div className="native2d-brand"><span className="native2d-kicker">FIELD STUDY · 02</span><h1>雾影庄 <span>原生 2D 样板</span></h1></div>
        <div className="native2d-source-controls" aria-label="数据来源">
          <div className="native2d-source-modes">
            <button type="button" className={sourceKind === 'fixture' ? 'is-active' : ''} onClick={() => setSourceKind('fixture')} data-testid="native2d-source-fixture">固定数据</button>
            <button type="button" className={sourceKind === 'public' ? 'is-active' : ''} onClick={() => setSourceKind('public')} data-testid="native2d-source-public">公开读取</button>
          </div>
          {sourceKind === 'fixture' && <select aria-label="固定数据快照" value={fixtureId} onChange={(event) => setFixtureId(event.target.value)} data-testid="native2d-source-fixture-select">{FIXTURE_IDS.map((id) => <option key={id} value={id} data-testid={`native2d-source-fixture-${id}`}>{FIXTURE_LABELS[id] ?? id}</option>)}</select>}
          <button className="native2d-button native2d-button-primary" type="button" onClick={applySource} data-testid="native2d-source-apply">载入来源</button>
        </div>
      </header>

      <section className="native2d-statusbar" aria-label="当前世界状态">
        <div className="native2d-source-identity" data-testid="native2d-source-label"><span className={`native2d-status-dot ${state.readState.status}`} /><span>{world ? `${world.scope.source === 'fixture' ? '固定数据' : '公开只读'} · ${world.worldName}` : currentSource?.kind === 'public' ? '公开只读来源' : '固定数据来源'}</span>{world && <small>{world.scope.worldId} / {world.scope.timelineId}</small>}</div>
        <div className="native2d-world-clock"><span data-testid="native2d-world-time">{world?.simNow ? formatWorldTime(world.simNow, world.timeZone) : world ? '时间未知' : '等待读取'}</span><small data-testid="native2d-world-timezone">{world ? world.timeZone : '—'}</small><small data-testid="native2d-state-version">版本 {world?.stateVersion ?? '未知'}</small></div>
        <div className="native2d-read-actions"><span className="native2d-read-status" data-testid="native2d-read-status">{readStatusLabel(state.readState.status)}</span><button type="button" className="native2d-button" onClick={() => controller.refresh()} disabled={!currentSource || readBusy} data-testid="native2d-refresh">{readBusy ? '读取中…' : '刷新事实'}</button></div>
      </section>

      {state.readState.status === 'stale' && <div className="native2d-alert native2d-alert-warning" data-testid="native2d-stale" role="status">刷新失败，当前仍显示上次成功读取的事实：{state.readState.errorMessage} <button type="button" onClick={() => controller.refresh()} data-testid="native2d-read-retry">重试读取</button></div>}
      {state.readState.status === 'error' && <div className="native2d-alert native2d-alert-error" data-testid="native2d-read-error" role="alert">读取失败：{state.readState.errorMessage} <button type="button" onClick={() => controller.refresh()} data-testid="native2d-read-retry">重试读取</button></div>}
      {state.notice && <div className="native2d-notice" role="status">{state.notice}<button type="button" aria-label="关闭提示" onClick={() => controller.clearNotice()}>×</button></div>}

      <div className="native2d-workspace">
        <aside className={`native2d-sidepanel ${infoOpen ? 'mobile-open' : ''}`} aria-label="世界事实">
          <div className="native2d-panel-heading"><div><span className="native2d-section-index">01 / FACTS</span><h2>世界事实</h2></div><button type="button" className="native2d-mobile-close" onClick={() => setInfoOpen(false)} aria-label="关闭事实面板">×</button></div>
          <section className="native2d-fact-section"><h3>居民 <span>{world?.residents.length ?? 0}</span></h3><div className="native2d-list" data-testid="native2d-resident-list">
            {world?.residents.map((resident, index) => <div className={`native2d-list-row ${state.selection?.kind === 'resident' && state.selection.personId === resident.personId ? 'selected' : ''}`} key={resident.personId}><button type="button" className="native2d-list-main" onClick={() => selectObject({ kind: 'resident', personId: resident.personId })} data-testid={`native2d-resident-${resident.personId}`}><span className={`native2d-avatar avatar-${index % 3}`} aria-hidden="true">{resident.name.slice(0, 1)}</span><span className="native2d-list-copy"><strong>{resident.name}</strong><small>{resident.locationName ?? '地点未知'}</small></span></button><button type="button" className={`native2d-follow-button ${state.follow?.personId === resident.personId ? 'following' : ''}`} onClick={() => controller.toggleFollow(resident.personId)} aria-label={state.follow?.personId === resident.personId ? `取消跟随 ${resident.name}` : `跟随 ${resident.name}`} data-testid={state.selection?.kind === 'resident' && state.selection.personId === resident.personId ? 'native2d-follow-toggle' : `native2d-follow-toggle-${resident.personId}`}>{state.follow?.personId === resident.personId ? '跟随中' : '跟随'}</button></div>)}
          </div></section>
          <section className="native2d-fact-section"><h3>地点 <span>{state.presentation?.locations.length ?? 0}</span></h3><div className="native2d-list" data-testid="native2d-location-list">
            {state.presentation?.locations.map((location) => <button type="button" className={`native2d-location-row ${state.selection?.kind === 'location' && state.selection.locationKey === location.locationKey ? 'selected' : ''}`} key={location.name} onClick={() => location.locationKey && selectObject({ kind: 'location', locationKey: location.locationKey })} disabled={!location.locationKey} data-testid={`native2d-location-${location.name}`}><span><strong>{location.name}</strong><small>{location.representation === 'interior' ? '可观察室内' : location.representation === 'unrepresented' ? '未提供室内' : location.representation === 'unknown' ? '场景映射未知' : '外景地点'}</small></span><span className="native2d-count">{location.residentIds.length}</span></button>)}
          </div></section>
          {selectedResident && <section className="native2d-detail" data-testid="native2d-resident-card"><span className="native2d-section-index">RESIDENT RECORD</span><h3 data-testid="native2d-resident-name">{selectedResident.name}</h3><p data-testid="native2d-resident-location">{selectedResident.locationName ?? '地点未知'}{selectedResident.locationName && isUnrepresented(selectedResident.locationName) ? ' · 未提供该地点的室内场景' : ''}</p><p data-testid="native2d-resident-activity">{selectedResident.activity ?? '活动未知'}</p></section>}
          {selectedLocation && <section className="native2d-detail" data-testid="native2d-location-card"><span className="native2d-section-index">LOCATION RECORD</span><h3>{selectedLocation.name}</h3><p data-testid="native2d-location-description">{selectedLocation.description || '来源未提供地点说明。'}</p><p>在场居民：{residentAtSelection.length ? residentAtSelection.map((resident) => resident.name).join('、') : '无已知居民'}</p></section>}
          {selectedBuilding && <section className="native2d-detail"><span className="native2d-section-index">BUILDING RECORD</span><h3>{BUILDING_LABELS[selectedBuilding.id] ?? selectedBuilding.id}</h3><p>{selectedBuilding.interiorSpaceId ? '入口可观察大厅' : '此建筑未提供室内场景'}</p></section>}
          <section className="native2d-space-section"><div className="native2d-section-heading"><h3>观察空间</h3><span data-testid="native2d-space-label">{isHall ? '主楼 · 大厅' : '庄园外景'}</span></div><div className="native2d-space-actions">{!isHall ? <button type="button" className="native2d-button" onClick={() => controller.enterHall(HALL_SPACE_ID)} data-testid="native2d-hall-enter">进入大厅</button> : <button type="button" className="native2d-button" onClick={() => controller.exitToExterior()} data-testid="native2d-hall-exit">返回外景</button>}{state.follow && <button type="button" className="native2d-button native2d-button-quiet" onClick={() => controller.toggleFollow(state.follow!.personId)}>取消跟随</button>}</div></section>
        </aside>

        <section className="native2d-scene-column" aria-label="庄园场景">
          <div className="native2d-scene-toolbar"><div><span className="native2d-section-index">02 / OBSERVATION</span><strong>{isHall ? '主楼大厅' : '雾影庄外景'}</strong></div><div className="native2d-toolbar-actions"><button type="button" className="native2d-icon-button" onClick={() => setInfoOpen(true)} aria-label="打开事实面板" data-testid="native2d-panel-toggle">事实</button><button type="button" className="native2d-button" onClick={() => setOverviewRequest((value) => value + 1)} data-testid="native2d-overview">返回全景</button></div></div>
          <div className="native2d-scene-frame"><Native2dViewport scene={MIST_MANOR_SCENE} presentation={state.presentation} selection={state.selection} followPersonId={state.follow?.status === 'following' ? state.follow.personId : null} movePreview={state.movePreview} overviewRequest={overviewRequest} onEvent={(event) => controller.handleViewportEvent(event)} onReady={(viewport) => { viewportRef.current = viewport; if (viewport && state.presentation) viewport.setPresentation(state.presentation) }} />{!state.presentation && <div className="native2d-scene-empty" role="status">{state.readState.status === 'error' ? '暂无可显示的世界数据' : '正在读取庄园状态…'}</div>}<div className="native2d-scene-caption"><span>固定斜俯视 · 观察模式</span><span>事实版本 {world?.stateVersion ?? '—'}</span></div></div>
          {state.follow && <div className="native2d-follow-banner" data-testid="native2d-follow-status">{state.follow.status === 'paused' ? state.follow.reason : `正在跟随 ${world?.residents.find((resident) => resident.personId === state.follow?.personId)?.name ?? ''}`}<button type="button" onClick={() => controller.toggleFollow(state.follow!.personId)}>结束跟随</button></div>}
          <section className={`native2d-edit-panel ${editOpen ? 'mobile-open' : ''}`} aria-label="本地布局编辑"><div className="native2d-edit-heading"><div><span className="native2d-section-index">03 / LOCAL LAYOUT</span><h2>建筑布局</h2></div><button type="button" className="native2d-mobile-close" onClick={() => setEditOpen(false)} aria-label="关闭编辑面板">×</button></div><div className="native2d-edit-controls"><label className="native2d-select-label">建筑<select value={buildingId} onChange={(event) => { setBuildingId(event.target.value); controller.select({ kind: 'building', buildingId: event.target.value }) }} data-testid="native2d-building-list">{MIST_MANOR_SCENE.buildings.map((building) => <option key={building.id} value={building.id} data-testid={`native2d-building-${building.id}`}>{BUILDING_LABELS[building.id] ?? building.id}</option>)}</select></label><button type="button" className="native2d-button" onClick={() => controller.startMove(buildingId)} disabled={editBlocked} data-testid="native2d-move">{state.moveMode ? '移动中…' : '移动建筑'}</button><button type="button" className="native2d-button native2d-button-primary" onClick={() => controller.applyMove()} disabled={!state.movePreview?.validation.valid || editBlocked} data-testid="native2d-apply">应用位置</button><button type="button" className="native2d-button" onClick={() => controller.cancelMove()} disabled={!state.moveMode} data-testid="native2d-cancel">取消预览</button><button type="button" className="native2d-button" onClick={() => controller.undo()} disabled={!state.canUndo || editBlocked} data-testid="native2d-undo">撤销</button><button type="button" className="native2d-button native2d-button-danger" onClick={() => controller.requestReset()} disabled={!world} data-testid="native2d-reset">重置布局</button></div>{isHall && <p className="native2d-inline-note">大厅观察期间不能编辑外景建筑。</p>}{state.restore.status === 'pending' && <div className="native2d-recovery" data-testid="native2d-restore-status" role="alert"><strong>本地布局需要处理 · {state.restore.kind}</strong><p>{state.restore.message}。旧记录尚未覆盖。</p><div><button type="button" className="native2d-button" onClick={() => controller.resolveRestore('retry')} data-testid="native2d-restore-retry">重新读取</button><button type="button" className="native2d-button" onClick={() => controller.resolveRestore('baseline')} data-testid="native2d-restore-baseline">使用初始布局</button><button type="button" className="native2d-button native2d-button-danger" onClick={() => controller.resolveRestore('reset')} data-testid="native2d-restore-reset">清除并重置…</button></div></div>}{state.moveMode && <div className="native2d-move-feedback" data-testid="native2d-move-status">{state.movePreview ? state.movePreview.validation.valid ? `候选位置 ${state.movePreview.target.x}, ${state.movePreview.target.z} · 可应用` : `候选位置 ${state.movePreview.target.x}, ${state.movePreview.target.z} · 不可用` : '在场景中拖动建筑以预览新位置'}{state.movePreview && !state.movePreview.validation.valid && <ul data-testid="native2d-conflict-reasons">{state.movePreview.validation.reasons.map((reason, index) => <li key={`${reason.code}-${index}`}>{reason.message}</li>)}</ul>}</div>}<div className="native2d-edit-footer"><span data-testid="native2d-save-status">{state.save.status === 'unsaved' ? state.save.message : '布局仅保存在此浏览器'}</span>{state.save.status === 'unsaved' && <button type="button" onClick={() => controller.retrySave()} data-testid="native2d-save-retry">重试保存</button>}</div></section>
        </section>
      </div>
      <button type="button" className="native2d-mobile-edit-toggle" onClick={() => setEditOpen(true)} data-testid="native2d-edit-panel-toggle">布局编辑</button>
      {state.pendingReset && <div className="native2d-modal-backdrop" role="presentation"><section className="native2d-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="native2d-reset-title"><span className="native2d-section-index">LOCAL ACTION</span><h2 id="native2d-reset-title">重置当前布局？</h2><p>仅删除当前来源、世界与时间线的 2D 本地布局（{state.pendingReset.affectedBuildings} 栋建筑）。不会修改真实世界、居民位置或其他范围的记录。</p><div><button type="button" className="native2d-button" onClick={() => controller.cancelReset()} data-testid="native2d-reset-cancel">取消</button><button type="button" className="native2d-button native2d-button-danger" onClick={() => controller.confirmReset()} data-testid="native2d-reset-confirm">确认重置</button></div></section></div>}
    </main>
  )
}

function readStatusLabel(status: SampleControllerState['readState']['status']): string { return ({ loading: '正在读取', ready: '事实已更新', stale: '显示旧事实', error: '读取失败' })[status] }
function formatWorldTime(value: string, timeZone: string): string { const date = new Date(value); if (Number.isNaN(date.getTime())) return '时间未知'; try { return new Intl.DateTimeFormat('zh-CN', { timeZone, dateStyle: 'medium', timeStyle: 'short', hour12: false }).format(date) } catch { return new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short', hour12: false }).format(date) } }
function isUnrepresented(locationName: string): boolean { const binding = MIST_MANOR_SCENE.locationBindings.find((item) => item.sourceLocationName === locationName); return !binding || binding.representation.kind === 'unrepresented' }
