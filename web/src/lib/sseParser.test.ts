import { describe, expect, it } from 'vitest'
import { createSseParser } from './sseParser'

describe('incremental SSE parser', () => {
  it('handles field and delimiter splits plus multiple frames in one chunk', () => {
    const parser = createSseParser()
    expect(parser.push('eve')).toEqual([])
    expect(parser.push('nt: event\r\ndata: {"id":')).toEqual([])
    expect(parser.push('"one"}\r\n\r\nevent: state\ndata: line 1\ndata: line 2\n\n')).toEqual([
      { event: 'event', data: '{"id":"one"}' },
      { event: 'state', data: 'line 1\nline 2' },
    ])
  })

  it('ignores comments and flushes a final unterminated frame', () => {
    const parser = createSseParser()
    expect(parser.push(': heartbeat\ndata: value')).toEqual([])
    expect(parser.finish()).toEqual([{ event: 'message', data: 'value' }])
  })
})
