import { afterEach, describe, expect, it, vi } from 'vitest'
import { startCompatibilityPolling } from './compatibility-polling'

describe('startCompatibilityPolling', () => {
  afterEach(() => vi.useRealTimers())

  it('queries at 1/2/4/8/8 seconds and stops after five queries', async () => {
    vi.useFakeTimers()
    const query = vi.fn(async () => undefined)
    startCompatibilityPolling({ query, isVisible: () => true, subscribeVisibility: () => () => undefined })

    for (const [index, delay] of [1_000, 2_000, 4_000, 8_000, 8_000].entries()) {
      await vi.advanceTimersByTimeAsync(delay)
      expect(query).toHaveBeenCalledTimes(index + 1)
    }
    expect(query).toHaveBeenCalledTimes(5)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(query).toHaveBeenCalledTimes(5)
  })

  it('pauses while hidden, resumes with the next interval, and stops cleanly', async () => {
    vi.useFakeTimers()
    let visible = false
    let onVisibilityChange: () => void = () => {}
    const query = vi.fn(async () => undefined)
    const stop = startCompatibilityPolling({
      query,
      isVisible: () => visible,
      subscribeVisibility: listener => { onVisibilityChange = listener; return () => { onVisibilityChange = () => {} } },
    })

    await vi.advanceTimersByTimeAsync(20_000)
    expect(query).not.toHaveBeenCalled()
    visible = true
    onVisibilityChange()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(query).toHaveBeenCalledTimes(1)

    visible = false
    onVisibilityChange()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(query).toHaveBeenCalledTimes(1)
    visible = true
    onVisibilityChange()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(query).toHaveBeenCalledTimes(2)

    stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('does not overlap requests when visibility changes during a pending query', async () => {
    vi.useFakeTimers()
    let notifyVisibility = () => {}
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const query = vi.fn(() => pending)
    const stop = startCompatibilityPolling({
      query,
      isVisible: () => true,
      subscribeVisibility: listener => { notifyVisibility = listener; return () => {} },
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(query).toHaveBeenCalledTimes(1)
    notifyVisibility()
    notifyVisibility()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(query).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(query).toHaveBeenCalledTimes(2)
    stop()
  })

  it('unsubscribes and does not restart polling when disposed during an in-flight query', async () => {
    vi.useFakeTimers()
    let unsubscribeCount = 0
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const query = vi.fn(() => pending)
    const stop = startCompatibilityPolling({
      query,
      isVisible: () => true,
      subscribeVisibility: () => () => { unsubscribeCount += 1 },
    })

    await vi.advanceTimersByTimeAsync(1_000)
    expect(query).toHaveBeenCalledTimes(1)
    stop()
    expect(unsubscribeCount).toBe(1)
    release()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(query).toHaveBeenCalledTimes(1)
  })
})
