import type { VoxelViewportProps } from '../../voxel/VoxelViewport'

/** Owns the preview's abortable reads and per-instance document cache. */
export class SceneRepairPreviewLifecycle<T> {
  private readonly cache = new Map<string, T>()
  private readonly controllers = new Set<AbortController>()

  get(key: string): T | undefined {
    return this.cache.get(key)
  }

  load(
    key: string,
    request: (signal: AbortSignal) => Promise<unknown>,
    decode: (value: unknown) => T | null,
    onValue: (value: T) => void,
    onError: (error: unknown) => void,
  ): () => void {
    const cached = this.cache.get(key)
    if (cached !== undefined) {
      onValue(cached)
      return () => undefined
    }

    const controller = new AbortController()
    this.controllers.add(controller)
    void request(controller.signal)
      .then(raw => {
        if (controller.signal.aborted) return
        const value = decode(raw)
        if (value === null) throw new Error('预览资料无法解析')
        this.cache.set(key, value)
        onValue(value)
      })
      .catch(error => {
        if (!controller.signal.aborted) onError(error)
      })
      .finally(() => this.controllers.delete(controller))

    return () => {
      controller.abort()
      this.controllers.delete(controller)
    }
  }

  dispose(): void {
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
    this.cache.clear()
  }
}

export function previewViewportKey(spaceId: string, side: 'before' | 'after'): string {
  return `${spaceId}:${side}`
}

export function activePreviewDocument<T>(loaded: { key: string; document: T } | null, selectedKey: string): T | null {
  return loaded?.key === selectedKey ? loaded.document : null
}

export function readonlyPreviewViewportProps(document: VoxelViewportProps['document'], spaceId: string, timeZone?: string | null) {
  return {
    document,
    spaceId,
    timeZone,
    instanceId: `repair-preview-${spaceId}`,
    probePrimary: false,
    fitContainer: true,
    editable: false,
  } satisfies Pick<VoxelViewportProps, 'document' | 'spaceId' | 'timeZone' | 'instanceId' | 'probePrimary' | 'fitContainer' | 'editable'>
}
