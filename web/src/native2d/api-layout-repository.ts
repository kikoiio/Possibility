import { apiFetch } from '../api/client'
import { createInitialLayout } from './layout-validation'
import type {
  LayoutRepository,
  LayoutState,
  RestoreResult,
  SampleScope,
  SaveResult,
  SceneDefinition,
} from './types'

interface ServerLayout {
  readonly sceneId: string
  readonly formatVersion: number
  readonly placements: LayoutState['placements']
  readonly version: number
  readonly contentHash?: string
}
interface ServerLayoutResponse {
  readonly layout: ServerLayout | null
}

type Request = <T>(path: string, options?: RequestInit) => Promise<T>

/**
 * Server-backed layout repository.
 *
 * The server version is the authority. A browser cache may be layered around
 * this repository by the caller, but this adapter never treats localStorage as
 * a source of truth and always loads the current server head first.
 */
export function createApiLayoutRepository(
  scene: SceneDefinition,
  request: Request = apiFetch,
): LayoutRepository {
  let version = new Map<string, number>()

  const save = async (layout: LayoutState): Promise<SaveResult> => {
    const expectedVersion = version.get(layout.scope.worldId) ?? 0
    const requestId = crypto.randomUUID()
    try {
      const response = await request<ServerLayoutResponse>(
        `/api/worlds/${encodeURIComponent(layout.scope.worldId)}/native2d/layout`,
        {
          method: 'PUT',
          body: JSON.stringify({
            expectedVersion,
            requestId,
            layout: {
              sceneId: layout.scope.sceneId,
              formatVersion: scene.version,
              placements: layout.placements,
            },
          }),
        },
      )
      if (!response.layout) return { ok: false, reason: 'storage_error', message: '服务端未返回布局 head' }
      version.set(layout.scope.worldId, response.layout.version)
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: 'storage_error', message: error instanceof Error ? error.message : String(error) }
    }
  }

  return {
    async load(scope: SampleScope): Promise<RestoreResult> {
      try {
        const response = await request<ServerLayoutResponse>(
          `/api/worlds/${encodeURIComponent(scope.worldId)}/native2d/layout`,
        )
        const record = response.layout
        if (!record) {
          version.set(scope.worldId, 0)
          return { status: 'ready', layout: createInitialLayout(scene, scope) }
        }
        // A server record from another scene/version is not a cache miss: it
        // must remain visible as incompatible so it cannot be overwritten.
        if (record.sceneId !== scope.sceneId || record.formatVersion !== scene.version) {
          return { status: 'incompatible', message: '服务端 2D 场景版本与当前场景不兼容，原记录已保留' }
        }
        version.set(scope.worldId, record.version)
        return { status: 'ready', layout: { scope, placements: record.placements } }
      } catch (error) {
        return { status: 'error', reason: 'storage_error', message: error instanceof Error ? error.message : String(error) }
      }
    },
    save,
    // Reset is a versioned baseline commit. It never deletes server history,
    // so a concurrent client can still recover the previous head.
    reset: (scope) => save(createInitialLayout(scene, scope)),
  }
}
