import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import VoxelViewport, { type VoxelViewportProps } from '../../../voxel/VoxelViewport'
import type { OrbitPose } from '../../../voxel/engine'
import type { PresentationAdapter, WorldPresentationContext } from './presentation-types'

type VoxelContext = WorldPresentationContext & { presentation: 'voxel3d' }

export type VoxelViewportPropsResolver = (
  context: VoxelContext,
  signal: AbortSignal,
) => VoxelViewportProps | Promise<VoxelViewportProps>

interface VoxelEngineHandle {
  getOrbitPose(): OrbitPose | null
  setOrbitPose(pose: OrbitPose): void
}

interface VoxelEngineRegistry {
  __voxelEngines?: Record<string, VoxelEngineHandle | undefined>
}

function engineFor(paneId: string): VoxelEngineHandle | undefined {
  return (window as Window & VoxelEngineRegistry).__voxelEngines?.[paneId]
}

/** Adapts the existing voxel viewport to one independently owned comparison pane. */
export function createVoxelPresentationAdapter(resolveProps: VoxelViewportPropsResolver): PresentationAdapter<'voxel3d'> {
  return {
    kind: 'voxel3d',
    async mount(host, context, options) {
      const props = await resolveProps(context, options.signal)
      if (options.signal.aborted) throw new DOMException('Pane load cancelled', 'AbortError')
      const root = createRoot(host)
      let disposed = false
      let latestPose = options.camera?.pose ?? null
      const renderViewport = () => root.render(createElement(VoxelViewport, {
        ...props,
        instanceId: context.paneId,
        probePrimary: false,
        fitContainer: true,
        cameraPose: latestPose,
        onCameraChange: (pose: OrbitPose) => {
          latestPose = pose
          options.onCameraChange?.({ kind: 'voxel3d', version: 1, pose })
        },
      }))
      renderViewport()
      return {
        captureCamera: () => {
          const pose = engineFor(context.paneId)?.getOrbitPose() ?? latestPose
          return pose ? { kind: 'voxel3d', version: 1, pose } : null
        },
        applyLinkedCamera: camera => {
          if (!disposed) {
            latestPose = camera.pose
            engineFor(context.paneId)?.setOrbitPose(camera.pose)
            // A sibling can move before this renderer finishes mounting. Keep the
            // controlled pose so VoxelViewport applies it as soon as its engine is ready.
            renderViewport()
          }
        },
        dispose: () => {
          if (disposed) return
          disposed = true
          const pose = engineFor(context.paneId)?.getOrbitPose()
          if (pose) latestPose = pose
          root.unmount()
        },
      }
    },
  }
}
