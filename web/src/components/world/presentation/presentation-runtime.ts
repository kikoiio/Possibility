import type { SerializedVoxelDocument, SerializedVoxelSpaces, VoxelDocument } from '@wispiva/voxel-contract'
import { authApi, guestMapApi, mapApi, publicApi } from '../../../api/client'
import type { MapScene } from '../../../api/map'
import type { WorldSnapshot } from '../../../api/types'
import { effectiveTimeZone } from '../../../lib/world-time'
import type { WorldEnvironmentFact, WorldReadModel, WorldRuntimeState } from '../../../native2d/types'
import { projectVoxelSpaceScene, supportsNative2dTheme } from '../../../native2d/voxel-scene-projection'
import type { VoxelViewportProps } from '../../../voxel/VoxelViewport'
import { parseVoxelDocument } from '../../../voxel/flags'
import { buildSceneOverlay } from '../../../scene/life/overlay'
import { createNative2dPresentationAdapter } from '../../../native2d/WorldPresentationAdapter'
import { createVoxelPresentationAdapter } from './VoxelPresentationAdapter'
import type { PresentationLifecycleAdapters } from './PresentationLifecycle'
import type {
  PaneSessionLoader,
  PaneTarget,
  PaneUnsupported,
  SpaceDescriptor,
  WorldPresentationContext,
} from './presentation-types'

export type PresentationAccessMode = 'account' | 'guest' | 'public'

interface RawPaneRead {
  snapshot: WorldSnapshot
  scene: MapScene
  access: Record<string, boolean>
  identity: WorldPresentationContext['identity']
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Pane load cancelled', 'AbortError')
}

function requestedTimeline(snapshot: WorldSnapshot, target: PaneTarget): string {
  return target.timelineId ?? snapshot.currentTimelineId
}

async function readPaneWorld(
  mode: PresentationAccessMode,
  target: PaneTarget,
  signal: AbortSignal,
): Promise<RawPaneRead> {
  if (mode === 'public') {
    const snapshot = await publicApi.snapshot(target.worldId, target.timelineId, signal)
    const scene = await publicApi.scene(target.worldId, { timelineId: snapshot.currentTimelineId, representation: 'voxel' }, signal)
    return { snapshot, scene, access: { observe: true }, identity: 'readonly' }
  }

  const [bootstrap, account] = mode === 'guest'
    ? [await guestMapApi.bootstrap(target.worldId, target.timelineId, signal), null] as const
    : await Promise.all([
      mapApi.bootstrap(target.worldId, target.timelineId, signal),
      authApi.me({ redirectOnUnauthorized: false }),
    ])
  const access = { ...bootstrap.access }
  const identity: WorldPresentationContext['identity'] = mode === 'guest' ? 'guest'
    : account?.user?.id && (access.editScene || access.persist) ? 'owner' : 'readonly'
  return { snapshot: bootstrap.world, scene: bootstrap.scene, access, identity }
}

function documentTheme(document: SerializedVoxelDocument | SerializedVoxelSpaces): string | null {
  if (document.format === 'voxel-spaces') return document.spaces[0]?.document.theme ?? null
  return document.theme
}

function unsupported(code: string, reason: string, alternatives?: readonly SpaceDescriptor[]): PaneUnsupported {
  return alternatives ? { kind: 'unsupported', code, reason, alternatives } : { kind: 'unsupported', code, reason }
}

function sceneMissing(scene: MapScene): PaneUnsupported | null {
  if (scene.status === 'ready') return null
  if (scene.status === 'unavailable') throw new Error('场景暂时不可用，请重试读取。')
  return unsupported('scene-missing', '这个世界还没有可呈现的场景。')
}

/** 空间描述与选定空间只来自场景信封本身；缺省目标在读取阶段一次性补为外景。 */
function resolveSpaces(
  envelope: SerializedVoxelDocument | SerializedVoxelSpaces,
  target: PaneTarget,
  native2dSupported: boolean,
): { kind: 'ok'; available: SpaceDescriptor[]; selectedId: string } | PaneUnsupported {
  const supported: SpaceDescriptor['supportedPresentations'] = native2dSupported
    ? ['voxel3d', 'native2d']
    : ['voxel3d']
  if (envelope.format === 'voxel-spaces') {
    const available: SpaceDescriptor[] = envelope.spaces.map(space => ({
      id: space.id,
      label: space.name || space.id,
      kind: space.id === 'exterior' || space.id.endsWith('-interior') ? (space.id === 'exterior' ? 'exterior' : 'interior') : 'unknown',
      supportedPresentations: supported,
    }))
    const selectedId = target.spaceId ?? available.find(space => space.kind === 'exterior')?.id
      ?? envelope.defaultSpaceId
    if (!available.some(space => space.id === selectedId)) {
      return available.length > 0
        ? unsupported('space-missing', '所选空间在当前场景中不存在，可改用以下可用空间。', available)
        : unsupported('space-missing', '所选空间在当前场景中不存在。')
    }
    return { kind: 'ok', available, selectedId }
  }
  const available: SpaceDescriptor[] = [{
    id: 'exterior', label: '外景', kind: 'exterior', supportedPresentations: supported,
  }]
  if (target.spaceId !== undefined && target.spaceId !== 'exterior') {
    return unsupported('space-missing', '所选空间在当前场景中不存在，可改用以下可用空间。', available)
  }
  return { kind: 'ok', available, selectedId: 'exterior' }
}

function selectedSpaceDocumentOf(
  envelope: SerializedVoxelDocument | SerializedVoxelSpaces,
  selectedId: string,
): { kind: 'ok'; document: VoxelDocument } | PaneUnsupported {
  if (envelope.format === 'voxel-spaces') {
    const space = envelope.spaces.find(item => item.id === selectedId)
    if (!space) return unsupported('space-missing', '所选空间在当前场景中不存在。')
    const document = parseVoxelDocument(space.document)
    return document
      ? { kind: 'ok', document }
      : unsupported('scene-format', '所选空间的场景数据格式暂不受支持。')
  }
  const document = parseVoxelDocument(envelope)
  return document
    ? { kind: 'ok', document }
    : unsupported('scene-format', '场景数据格式暂不受支持。')
}

function environmentFacts(snapshot: WorldSnapshot): readonly WorldEnvironmentFact[] {
  return snapshot.currentFacts
    .filter(fact => fact.factType === 'environment')
    .map(fact => ({
      id: fact.id,
      locationName: typeof fact.value.location === 'string' ? fact.value.location : null,
      condition: typeof fact.value.condition === 'string' ? fact.value.condition : '',
      value: typeof fact.value.value === 'string' ? fact.value.value : String(fact.value.value ?? ''),
      simTime: fact.simTime,
      version: fact.version,
    }))
}

function runtimeStateOf(snapshot: WorldSnapshot): WorldRuntimeState {
  return {
    status: snapshot.world.status,
    pauseReason: snapshot.world.pauseReason,
    callsToday: snapshot.world.callsToday,
    worldModelVersion: snapshot.worldModelVersion,
    evidenceStatus: snapshot.evidenceStatus,
  }
}

/** 同一次 snapshot 生成读模型；2D 表现和环境覆盖层与 3D 事实同源。 */
function worldReadModelOf(
  snapshot: WorldSnapshot,
  identity: WorldPresentationContext['identity'],
  sceneId: string,
  sceneVersion: number,
): WorldReadModel {
  return {
    scope: {
      source: identity === 'readonly' ? 'public' : 'account',
      worldId: snapshot.world.id,
      timelineId: snapshot.currentTimelineId,
      sceneId,
      sceneVersion,
    },
    worldName: snapshot.world.name,
    simNow: snapshot.simNow,
    timeZone: effectiveTimeZone(snapshot.timeZone ?? snapshot.world.timeZone),
    stateVersion: snapshot.stateVersion,
    locations: snapshot.world.locations.map(location => ({ name: location.name, description: location.description })),
    residents: snapshot.locationBoard.flatMap(entry => entry.persons.map(person => ({
      personId: person.id,
      name: person.name,
      locationName: entry.location,
      activity: person.activity.trim() ? person.activity : null,
    }))),
    environment: environmentFacts(snapshot),
    runtime: runtimeStateOf(snapshot),
  }
}

function sceneIdentityOf(envelope: SerializedVoxelDocument | SerializedVoxelSpaces, selectedId: string): string {
  if (envelope.format === 'voxel-spaces') {
    return envelope.spaces.find(space => space.id === selectedId)?.document.id ?? envelope.spaces[0]?.document.id ?? selectedId
  }
  return envelope.id
}

/** Creates the per-pane API/session and renderer factories for the approved workspace. */
export function createPresentationRuntime(mode: PresentationAccessMode): {
  loadSession: PaneSessionLoader
  adapters: PresentationLifecycleAdapters
} {
  const loadSession: PaneSessionLoader = async (target, signal) => {
    throwIfAborted(signal)
    const data = await readPaneWorld(mode, target, signal)
    throwIfAborted(signal)
    // 服务端回显是唯一事实：目标不匹配绝不静默改用其他世界或时间线。
    if (data.snapshot.world.id !== target.worldId) {
      throw new Error('服务端返回的世界与请求目标不一致，请重试读取。')
    }
    const timelineId = requestedTimeline(data.snapshot, target)
    if (data.snapshot.currentTimelineId !== timelineId) {
      throw new Error('服务端返回了不同时间线，请重试读取。')
    }
    const sceneMissingResult = sceneMissing(data.scene)
    if (sceneMissingResult) return sceneMissingResult
    const scene = data.scene as Extract<MapScene, { status: 'ready' }>
    const envelope: SerializedVoxelDocument | SerializedVoxelSpaces = scene.document
    const native2dSupported = supportsNative2dTheme(documentTheme(envelope))
    const spaces = resolveSpaces(envelope, target, native2dSupported)
    if (spaces.kind === 'unsupported') return spaces
    const selectedSpace = selectedSpaceDocumentOf(envelope, spaces.selectedId)
    if (selectedSpace.kind === 'unsupported') return selectedSpace
    throwIfAborted(signal)

    const sceneVersion = scene.version ?? 0
    const sceneId = sceneIdentityOf(envelope, spaces.selectedId)
    const worldReadModel = worldReadModelOf(data.snapshot, data.identity, sceneId, sceneVersion)
    if (target.presentation === 'native2d') {
      // 2D 的可呈现性在读取层判定：主题不支持或空间不可投影时直接给出原因，
      // 绝不把静态庄园样板当作成功结果。
      const projected = projectVoxelSpaceScene({
        envelope,
        spaceId: spaces.selectedId,
        world: worldReadModel,
        sceneId,
        sceneVersion,
      })
      if (projected.kind === 'unsupported') return projected
    }

    const context: WorldPresentationContext = {
      paneId: 'single',
      worldId: target.worldId,
      timelineId,
      spaceId: spaces.selectedId,
      presentation: target.presentation,
      identity: data.identity,
      capabilities: data.access,
      sceneId,
      sceneVersion,
      stateVersion: data.snapshot.stateVersion ?? null,
      simNow: data.snapshot.simNow,
      timeZone: effectiveTimeZone(data.snapshot.timeZone ?? data.snapshot.world.timeZone),
      availableSpaces: spaces.available,
    }
    return {
      context,
      snapshot: data.snapshot,
      sceneDocument: envelope,
      selectedSpaceDocument: selectedSpace.document,
      worldReadModel,
    }
  }

  const adapters: PresentationLifecycleAdapters = {
    // 两个适配器只消费同一次读取结果；不再各自重读世界或猜测空间。
    voxel3d: createVoxelPresentationAdapter(async data => {
      const names = Object.fromEntries(data.snapshot.locationBoard.flatMap(row => row.persons.map(person => [person.id, person.name])))
      const props: VoxelViewportProps = {
        document: data.selectedSpaceDocument,
        spaceId: data.context.spaceId,
        overlay: buildSceneOverlay(data.snapshot, data.context.timelineId),
        events: data.snapshot.voxelEvents ?? null,
        timeZone: data.context.timeZone,
        personNames: names,
      }
      return props
    }),
    native2d: createNative2dPresentationAdapter(async data => {
      const projected = projectVoxelSpaceScene({
        envelope: data.sceneDocument,
        spaceId: data.context.spaceId,
        world: data.worldReadModel,
        sceneId: data.context.sceneId,
        sceneVersion: data.context.sceneVersion,
      })
      if (projected.kind === 'unsupported') throw new Error(projected.reason)
      return { scene: projected.scene, presentation: projected.presentation }
    }),
  }
  return { loadSession, adapters }
}
