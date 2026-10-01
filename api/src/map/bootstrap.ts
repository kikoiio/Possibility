import { and, eq } from 'drizzle-orm'
import type { SerializedVoxelDocument, SerializedVoxelSpaces } from '@possibility/voxel-contract'
import { readCurrentScene } from '../scenes/repository'
import { worldSnapshot } from '../worlds/queries'
import type { Db } from '../db/client'
import { worlds } from '../db/schema'
import { readGuestMapResume, readMapResume } from './resume'
import type { AccessContext } from '../access/types'
import { resolveWorldScope } from '../access/world-scope'

export interface WorldCapabilities {
  observe: boolean; participate: boolean; editScene: boolean; fork: boolean; compare: boolean; persist: boolean; resetDemo: boolean
}
export interface WorldPresentation {
  timelineId: string
  stateVersion: number
  simNow: string
  timeOfDay: 'dawn' | 'day' | 'dusk' | 'night'
  weather: { kind: string | null; label: string | null }
  residents: { personId: string; name: string; locationName: string; activity: string; animationState: string }[]
  locations: { name: string; description: string; residentCount: number }[]
  signals: { eventId: string; locationName: string; kind: 'movement' | 'gathering' | 'conversation' | 'environment'; emphasis: 'ambient' | 'noticeable' }[]
}
export interface MapBootstrap {
  access: WorldCapabilities
  world: Awaited<ReturnType<typeof worldSnapshot>>
  scene: { status: 'ready'; document: SerializedVoxelDocument | SerializedVoxelSpaces } | { status: 'missing' } | { status: 'unavailable'; retryable: boolean }
  presentation: WorldPresentation
  theme: { id: string; assetVersion: string }
  resume: { worldId: string; timelineId: string; spaceId: string; mode: 'create' | 'life' | 'possibility'; updatedAt: string }
}

function timeOfDay(simNow: string): WorldPresentation['timeOfDay'] {
  const hour = new Date(simNow).getUTCHours()
  if (hour < 6) return 'night'
  if (hour < 9) return 'dawn'
  if (hour < 17) return 'day'
  if (hour < 20) return 'dusk'
  return 'night'
}

/** Read-only bootstrap; it never advances the simulation or writes a scene revision. */
export async function loadMapBootstrap(db: Db, worldId: string, userId: string, timelineId?: string): Promise<MapBootstrap | null> {
  return loadMapBootstrapForAccess(db, worldId, { kind: 'user', userId, username: '', role: 'user', ownerId: userId }, timelineId)
}

export async function loadMapBootstrapForAccess(db: Db, worldId: string, access: AccessContext, timelineId?: string): Promise<MapBootstrap | null> {
  const scope = await resolveWorldScope(db, access, worldId)
  if (!scope) return null
  const preference = access.kind === 'user' ? await readMapResume(db, access.userId, worldId)
    : access.kind === 'guest' ? await readGuestMapResume(db, access.sessionId) : null
  let snapshot = await worldSnapshot(db, worldId, timelineId ?? preference?.timelineId)
  if (!snapshot && !timelineId) snapshot = await worldSnapshot(db, worldId)
  if (!snapshot) return null
  let scene: MapBootstrap['scene']
  try {
    const stored = await readCurrentScene(db, worldId)
    // S2 起存储层只剩体素系负载,格式由客户端按信封识别
    scene = !stored ? { status: 'missing' } : { status: 'ready', document: stored.document }
  } catch {
    scene = { status: 'unavailable', retryable: true }
  }
  const residents = snapshot.locationBoard.flatMap(location => location.persons.map(person => ({
    personId: person.id, name: person.name, locationName: location.location, activity: person.activity,
    animationState: 'idle' as const,
  })))
  const presentation: WorldPresentation = {
    timelineId: snapshot.currentTimelineId,
    stateVersion: snapshot.stateVersion,
    simNow: snapshot.simNow,
    timeOfDay: timeOfDay(snapshot.simNow),
    weather: { kind: null, label: null },
    residents,
    locations: snapshot.world.locations.map(location => ({
      name: location.name, description: location.description,
      residentCount: snapshot.locationBoard.find(row => row.location === location.name)?.persons.length ?? 0,
    })),
    signals: snapshot.events.map(event => ({
      eventId: event.id,
      locationName: event.location ?? '',
      kind: event.dialogueId ? 'conversation' : event.kind === 'movement' ? 'movement' : 'environment',
      emphasis: 'noticeable',
    })),
  }
  const defaultTimelineId = snapshot.currentTimelineId
  const defaultSpaceId = scene.status === 'ready' && 'defaultSpaceId' in scene.document ? scene.document.defaultSpaceId : 'exterior'
  const spaceId = preference && scene.status === 'ready' && 'spaces' in scene.document && scene.document.spaces.some(space => space.id === preference.spaceId)
    ? preference.spaceId : defaultSpaceId
  const mode = preference?.mode === 'create' || preference?.mode === 'possibility' ? preference.mode : 'life'
  return {
    access: scope.capabilities,
    world: snapshot,
    scene,
    presentation,
    theme: {
      id: scene.status === 'missing' || scene.status === 'unavailable' ? 'contemporary-daily-life'
        : 'theme' in scene.document ? scene.document.theme
          : scene.document.spaces[0]?.document.theme ?? 'mist-manor',
      assetVersion: 'current',
    },
    resume: { worldId, timelineId: defaultTimelineId, spaceId, mode, updatedAt: preference?.updatedAt ?? new Date().toISOString() },
  }
}
