import { createNative2dViewport } from './viewport'
import type { Camera } from './projection'
import type { SceneDefinition, ScenePresentation } from './types'
import type { PresentationAdapter, WorldPresentationContext } from '../components/world/presentation/presentation-types'

type Native2dContext = WorldPresentationContext & { presentation: 'native2d' }

export type Native2dPresentationSource = (
  context: Native2dContext,
  signal: AbortSignal,
) => Promise<{ scene: SceneDefinition; presentation: ScenePresentation }>

/** Adapts the native Pixi viewport to a pane with independent camera ownership. */
export function createNative2dPresentationAdapter(source: Native2dPresentationSource): PresentationAdapter<'native2d'> {
  return {
    kind: 'native2d',
    async mount(host, context, options) {
      const { scene, presentation } = await source(context, options.signal)
      if (options.signal.aborted) throw new DOMException('Pane load cancelled', 'AbortError')
      const viewport = await createNative2dViewport(host, scene, {
        signal: options.signal,
        initialCamera: options.camera?.camera,
        onEvent: () => {},
        onCameraChange: camera => options.onCameraChange?.({ kind: 'native2d', version: 1, camera }),
      })
      if (options.signal.aborted) {
        viewport.dispose()
        throw new DOMException('Pane load cancelled', 'AbortError')
      }
      viewport.setPresentation(presentation)
      if (options.camera) viewport.setCamera(options.camera.camera)
      return {
        captureCamera: () => ({ kind: 'native2d', version: 1, camera: viewport.getCamera() }),
        applyLinkedCamera: camera => viewport.setCamera(camera.camera),
        dispose: () => viewport.dispose(),
      }
    },
  }
}
