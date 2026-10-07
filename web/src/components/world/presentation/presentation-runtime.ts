import { authApi, guestMapApi, mapApi, publicApi } from '../../../api/client'
import type { MapBootstrap } from '../../../api/map'
import type { WorldSnapshot } from '../../../api/types'
import { createInitialLayout } from '../../../native2d/layout-validation'
import { buildPresentation } from '../../../native2d/presentation'
import { createWorldSource } from '../../../native2d/world-source'
import { MIST_MANOR_SCENE } from '../../../native2d/scene'
import type { WorldReadModel } from '../../../native2d/types'
import type { VoxelViewportProps } from '../../../voxel/VoxelViewport'
import { parseVoxelDocument, parseVoxelSpaces } from '../../../voxel/flags'
import { buildSceneOverlay } from '../../../scene/life/overlay'
import type { PaneSessionLoader } from './ComparisonPane'
import { createNative2dPresentationAdapter } from '../../../native2d/WorldPresentationAdapter'
import { createVoxelPresentationAdapter } from './VoxelPresentationAdapter'
import type { PresentationLifecycleAdapters } from './PresentationLifecycle'
import type { PaneTarget, WorldPresentationContext } from './presentation-types'

export type PresentationAccessMode = 'account' | 'guest' | 'public'

interface PaneWorldData {
  snapshot: WorldSnapshot
  bootstrap?: MapBootstrap
  document: unknown
  access: Record<string, boolean>
  identity: WorldPresentationContext['identity']
}

function requestedTimeline(snapshot: WorldSnapshot, target: PaneTarget): string {
  return target.timelineId ?? snapshot.currentTimelineId
}

async function readPaneWorld(
  mode: PresentationAccessMode,
  target: PaneTarget,
  signal: AbortSignal,
): Promise<PaneWorldData> {
  if (mode === 'public') {
    const [snapshot, scene] = await Promise.all([
      publicApi.snapshot(target.worldId, target.timelineId, signal),
      publicApi.scene(target.worldId, signal),
    ])
    if (scene.status !== 'ready') throw new Error('这个世界还没有可呈现的 3D 场景。')
    return { snapshot, document: scene.document, access: { observe: true }, identity: 'readonly' }
  }

  const [bootstrap, account] = mode === 'guest'
    ? [await guestMapApi.bootstrap(target.worldId, target.timelineId, signal), null] as const
    : await Promise.all([
      mapApi.bootstrap(target.worldId, target.timelineId, signal),
      authApi.me({ redirectOnUnauthorized: false }),
    ])
  if (bootstrap.scene.status !== 'ready') throw new Error('这个世界还没有可呈现的 3D 场景。')
  const access = { ...bootstrap.access }
  const identity: WorldPresentationContext['identity'] = mode === 'guest' ? 'guest'
    : account?.user?.id && (access.editScene || access.persist) ? 'owner' : 'readonly'
  return { snapshot: bootstrap.world, bootstrap, document: bootstrap.scene.document, access, identity }
}

function selectVoxelDocument(data: PaneWorldData, worldId: string) {
  const spaces = parseVoxelSpaces(data.document)
  if (spaces) {
    const selectedId = data.bootstrap?.resume.spaceId ?? spaces.defaultSpaceId
    const space = spaces.spaces.find(item => item.id === selectedId)
      ?? spaces.spaces.find(item => item.id === spaces.defaultSpaceId)
    const document = space ? parseVoxelDocument(space.document) : null
    if (document) return { document, spaceId: space!.id }
  }
  const document = parseVoxelDocument(data.document)
  if (!document) throw new Error(`世界 ${worldId} 返回的 3D 场景格式不受支持。`)
  return { document, spaceId: 'exterior' }
}

function guestWorldReadModel(snapshot: WorldSnapshot): WorldReadModel {
  const timelineId = snapshot.currentTimelineId
  return {
    scope: {
      source: 'account',
      worldId: snapshot.world.id,
      timelineId,
      sceneId: MIST_MANOR_SCENE.id,
      sceneVersion: MIST_MANOR_SCENE.version,
    },
    worldName: snapshot.world.name,
    simNow: snapshot.simNow,
    timeZone: snapshot.timeZone ?? snapshot.world.timeZone ?? 'UTC',
    stateVersion: snapshot.stateVersion,
    locations: snapshot.world.locations.map(location => ({ name: location.name, description: location.description })),
    residents: snapshot.locationBoard.flatMap(location => location.persons.map(person => ({
      personId: person.id,
      name: person.name,
      locationName: location.location,
      activity: person.activity || null,
    }))),
  }
}

/** Creates the per-pane API/session and renderer factories for the approved workspace. */
export function createPresentationRuntime(mode: PresentationAccessMode): {
  loadSession: PaneSessionLoader
  adapters: PresentationLifecycleAdapters
} {
  const loadSession: PaneSessionLoader = async (target, signal) => {
    const data = await readPaneWorld(mode, target, signal)
    const timelineId = requestedTimeline(data.snapshot, target)
    if (timelineId !== data.snapshot.currentTimelineId) {
      throw new Error('服务端返回了不同时间线，请重试读取。')
    }
    return {
      paneId: 'single',
      worldId: target.worldId,
      timelineId,
      presentation: target.presentation,
      identity: data.identity,
      capabilities: data.access,
      stateVersion: data.snapshot.stateVersion,
      simNow: data.snapshot.simNow,
    }
  }

  const adapters: PresentationLifecycleAdapters = {
    voxel3d: createVoxelPresentationAdapter(async (context, signal): Promise<VoxelViewportProps> => {
      const data = await readPaneWorld(mode, context, signal)
      const { document, spaceId } = selectVoxelDocument(data, context.worldId)
      const names = Object.fromEntries(data.snapshot.locationBoard.flatMap(row => row.persons.map(person => [person.id, person.name])))
      return {
        document,
        spaceId,
        overlay: buildSceneOverlay(data.snapshot, context.timelineId),
        events: data.snapshot.voxelEvents ?? null,
        timeZone: data.snapshot.timeZone ?? data.snapshot.world.timeZone ?? 'UTC',
        personNames: names,
      }
    }),
    native2d: createNative2dPresentationAdapter(async (context, signal) => {
      if (mode === 'guest') {
        const { snapshot } = await readPaneWorld(mode, context, signal)
        const world = guestWorldReadModel(snapshot)
        const layout = createInitialLayout(MIST_MANOR_SCENE, world.scope)
        return {
          scene: MIST_MANOR_SCENE,
          presentation: buildPresentation(world, MIST_MANOR_SCENE, layout, MIST_MANOR_SCENE.defaultSpaceId),
        }
      }
      const source = createWorldSource({
        kind: mode === 'account' ? 'account' : 'public',
        worldId: context.worldId,
        timelineId: context.timelineId,
      }, MIST_MANOR_SCENE)
      const world = await source.load(signal)
      const layout = createInitialLayout(MIST_MANOR_SCENE, world.scope)
      const presentation = buildPresentation(world, MIST_MANOR_SCENE, layout, MIST_MANOR_SCENE.defaultSpaceId)
      return { scene: MIST_MANOR_SCENE, presentation }
    }),
  }
  return { loadSession, adapters }
}
