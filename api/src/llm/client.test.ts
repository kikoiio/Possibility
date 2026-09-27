import { afterEach, describe, expect, it, vi } from 'vitest'
import { complete, completeContract, streamChat, type ReceiptReservation } from './client'
import { contractViolation } from './contracts'

afterEach(() => vi.unstubAllGlobals())

describe('LLM 流式客户端', () => {
  it('响应头成功但正文停住时仍会超时并取消 reader', async () => {
    let cancelled = false
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start() {},
      cancel() { cancelled = true },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } })))
    const iterator = streamChat({ baseUrl: 'https://llm.invalid', apiKey: 'x', model: 'x', reserve: async () => {} }, [], undefined, { timeoutMs: 100 })
    await expect((async () => { for await (const _ of iterator) { /* timeout expected */ } })())
      .rejects.toMatchObject({ code: 'timeout' })
    expect(cancelled).toBe(true)
  })

  it('passes only a context hash into the receipt and settles a successful call', async () => {
    const settle = vi.fn(async () => {})
    const reserveMock = vi.fn(async () => 'receipt-success')
    const reserve = Object.assign(reserveMock, { settle }) as ReceiptReservation
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'A safe answer.' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))

    await expect(complete({ baseUrl: 'https://llm.invalid', apiKey: 'x', model: 'x', reserve }, [
      { role: 'user', content: 'private prompt text' },
    ], { requestId: 'request-1', contractVersion: 'test/v1' })).resolves.toBe('A safe answer.')
    expect(reserve).toHaveBeenCalledWith({ requestId: 'request-1', contextHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      contractVersion: 'test/v1' })
    expect(JSON.stringify(reserveMock.mock.calls)).not.toContain('private prompt text')
    expect(settle).toHaveBeenCalledWith('receipt-success', 'completed', null)
  })

  it('settles invalid JSON as failed and a timed-out stream as cancelled', async () => {
    const failedSettle = vi.fn(async () => {})
    const failedReserve = Object.assign(vi.fn(async () => 'receipt-failed'), { settle: failedSettle }) as ReceiptReservation
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{not json', { status: 200 })))
    await expect(complete({ baseUrl: 'https://llm.invalid', apiKey: 'x', model: 'x', reserve: failedReserve }, []))
      .rejects.toMatchObject({ code: 'invalid_json' })
    expect(failedSettle).toHaveBeenCalledWith('receipt-failed', 'failed', 'invalid_json')

    const cancelledSettle = vi.fn(async () => {})
    const cancelledReserve = Object.assign(vi.fn(async () => 'receipt-cancelled'),
      { settle: cancelledSettle }) as ReceiptReservation
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start() {} }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } })))
    const iterator = streamChat({ baseUrl: 'https://llm.invalid', apiKey: 'x', model: 'x', reserve: cancelledReserve },
      [], undefined, { timeoutMs: 10 })
    await expect((async () => { for await (const _ of iterator) { /* timeout expected */ } })()).rejects.toBeTruthy()
    expect(cancelledSettle).toHaveBeenCalledWith('receipt-cancelled', 'cancelled', 'timeout')
  })

  it('settles a structured call only after its domain contract passes', async () => {
    const settle = vi.fn(async () => {})
    const reserve = Object.assign(vi.fn(async () => 'receipt-contract'), { settle }) as ReceiptReservation
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"items":[]}' } }],
    }), { status: 200 })))

    await expect(completeContract({ baseUrl: 'https://llm.invalid', apiKey: 'x', model: 'x', reserve }, [], {
      contractVersion: 'schedule/v1',
      parse: () => contractViolation('schedule/v1', '日程项数量非法'),
    })).rejects.toMatchObject({ code: 'contract_violation' })
    expect(settle).toHaveBeenCalledOnce()
    expect(settle).toHaveBeenCalledWith('receipt-contract', 'failed', 'contract_violation')
  })

  it('accepts only an explicit completion marker and rejects EOF after partial text as truncated', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"content":"Complete"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )))
    const completed: string[] = []
    for await (const event of streamChat({ baseUrl: 'https://llm.invalid', apiKey: 'x', model: 'x',
      reserve: async () => {} }, [])) completed.push(event.type)
    expect(completed).toEqual(['text', 'done'])

    const truncatedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n'))
        controller.close()
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(truncatedBody,
      { status: 200, headers: { 'content-type': 'text/event-stream' } })))
    const received: string[] = []
    await expect((async () => {
      for await (const event of streamChat({ baseUrl: 'https://llm.invalid', apiKey: 'x', model: 'x',
        reserve: async () => {} }, [])) {
        if (event.type === 'text') received.push(event.delta)
      }
    })()).rejects.toMatchObject({ code: 'truncated' })
    expect(received).toEqual(['Partial'])
    expect(truncatedBody.locked).toBe(false)
  })

  it('rejects malformed SSE JSON and maps external abort to cancelled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: {bad json}\n\ndata: [DONE]\n\n', {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    })))
    await expect((async () => {
      for await (const _ of streamChat({ baseUrl: 'https://llm.invalid', apiKey: 'x', model: 'x',
        reserve: async () => {} }, [])) { /* malformed frame expected */ }
    })()).rejects.toMatchObject({ code: 'malformed_stream' })

    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start() {} }), {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    })))
    const pending = (async () => {
      for await (const _ of streamChat({ baseUrl: 'https://llm.invalid', apiKey: 'x', model: 'x',
        reserve: async () => {} }, [], undefined, { signal: controller.signal })) { /* abort expected */ }
    })()
    controller.abort(new Error('caller left'))
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('accepts an explicit provider completion event', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      'data: {"choices":[{"delta":{"content":"Complete"}}]}\n\ndata: {"type":"response.completed"}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )))
    const events = []
    for await (const event of streamChat({ baseUrl: 'https://llm.invalid', apiKey: 'x', model: 'x',
      reserve: async () => {} }, [])) events.push(event)
    expect(events.at(-1)).toEqual({ type: 'done' })
  })
})
