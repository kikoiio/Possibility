import { describe, expect, it, vi } from 'vitest'
import type { VoxelDocument } from '@possibility/voxel-contract'
import { activePreviewDocument, previewViewportKey, readonlyPreviewViewportProps, SceneRepairPreviewLifecycle } from './scene-repair-preview-lifecycle'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('SceneRepairPreview lifecycle', () => {
  it('loads source and candidate independently for each space and caches the opened view', async () => {
    const lifecycle = new SceneRepairPreviewLifecycle<string>()
    const candidate = vi.fn(async () => 'candidate-main')
    const source = vi.fn(async () => 'source-main')
    const decode = (value: unknown) => typeof value === 'string' ? value : null
    const received: string[] = []

    const stopCandidate = lifecycle.load(previewViewportKey('main', 'after'), candidate, decode, value => received.push(value), () => {})
    await Promise.resolve()
    await Promise.resolve()
    expect(received).toEqual(['candidate-main'])
    stopCandidate()
    lifecycle.load(previewViewportKey('main', 'before'), source, decode, value => received.push(value), () => {})
    await Promise.resolve()
    await Promise.resolve()
    lifecycle.load(previewViewportKey('room', 'after'), candidate, decode, value => received.push(value), () => {})
    await Promise.resolve()
    await Promise.resolve()

    expect(source).toHaveBeenCalledTimes(1)
    expect(candidate).toHaveBeenCalledTimes(2)
    expect(received).toEqual(['candidate-main', 'source-main', 'candidate-main'])
    expect(previewViewportKey('main', 'before')).not.toBe(previewViewportKey('main', 'after'))
    expect(previewViewportKey('main', 'after')).not.toBe(previewViewportKey('room', 'after'))
    expect(activePreviewDocument({ key: 'main:after', document: 'old-renderer-document' }, 'room:after')).toBeNull()
    lifecycle.dispose()
  })

  it('aborts in-flight reads and clears owned preview documents when switched or closed', async () => {
    const lifecycle = new SceneRepairPreviewLifecycle<string>()
    const oldRead = deferred<string>()
    const closingRead = deferred<string>()
    const values: string[] = []
    let oldSignal!: AbortSignal
    let closingSignal!: AbortSignal
    const decode = (value: unknown) => typeof value === 'string' ? value : null

    const stopOld = lifecycle.load('main:after', signal => { oldSignal = signal; return oldRead.promise }, decode, value => values.push(value), () => {})
    stopOld() // changing side/space aborts the previous request
    expect(oldSignal.aborted).toBe(true)
    lifecycle.load('main:before', async () => 'cached-source', decode, value => values.push(value), () => {})
    await Promise.resolve()
    await Promise.resolve()
    lifecycle.load('room:after', signal => { closingSignal = signal; return closingRead.promise }, decode, value => values.push(value), () => {})

    lifecycle.dispose() // closing the preview aborts pending reads and drops its document cache
    expect(closingSignal.aborted).toBe(true)
    expect(lifecycle.get('main:before')).toBeUndefined()
    oldRead.resolve('late-candidate')
    closingRead.resolve('late-room')
    await Promise.resolve()
    await Promise.resolve()
    expect(values).toEqual(['cached-source'])
  })

  it('passes only explicitly read-only viewport options, with no edit/apply/save callbacks', () => {
    const document = {} as VoxelDocument
    const props = readonlyPreviewViewportProps(document, 'main', 'Asia/Shanghai')
    expect(props).toMatchObject({ document, spaceId: 'main', timeZone: 'Asia/Shanghai', editable: false, probePrimary: false })
    expect(props).not.toHaveProperty('onSave')
    expect(props).not.toHaveProperty('planEdits')
    expect(props).not.toHaveProperty('preflightEdits')
  })
})
