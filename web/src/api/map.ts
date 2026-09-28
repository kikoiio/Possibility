import type { SceneDocumentAny } from '@possibility/scene-contract'
import type { WorldSnapshot } from './types'

export interface WorldCapabilities {
  observe: boolean
  participate: boolean
  editScene: boolean
  fork: boolean
  compare: boolean
  persist: boolean
  resetDemo: boolean
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
export type MapScene = { status: 'ready' | 'legacy'; document: SceneDocumentAny } | { status: 'missing' } | { status: 'unavailable'; retryable: boolean }
export interface MapBootstrap {
  access: WorldCapabilities
  world: WorldSnapshot
  scene: MapScene
  presentation: WorldPresentation
  theme: { id: string; assetVersion: string }
  resume: { worldId: string; timelineId: string; spaceId: string; mode: 'create' | 'life' | 'possibility'; updatedAt: string }
}
