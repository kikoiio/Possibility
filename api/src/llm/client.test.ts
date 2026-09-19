import { afterEach, describe, expect, it, vi } from 'vitest'
import { streamChat } from './client'

afterEach(() => vi.unstubAllGlobals())

describe('LLM 流式客户端', () => {
  it('响应头成功但正文停住时仍会超时并取消 reader', async () => {
    let cancelled = false
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start() {},
      cancel() { cancelled = true },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })))
    const iterator = streamChat({ baseUrl: 'https://llm.invalid', apiKey: 'x', model: 'x', reserve: async () => {} }, [], undefined, { timeoutMs: 10 })
    await expect((async () => { for await (const _ of iterator) { /* timeout expected */ } })()).rejects.toBeTruthy()
    expect(cancelled).toBe(true)
  })
})
