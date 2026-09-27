export interface ParsedSseFrame { event: string; data: string }

/** Incremental SSE parser that tolerates arbitrary transport chunk boundaries. */
export function createSseParser() {
  let buffer = ''
  const drain = (): ParsedSseFrame[] => {
    const frames: ParsedSseFrame[] = []
    buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      let event = 'message'
      const data: string[] = []
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
      }
      if (data.length) frames.push({ event, data: data.join('\n') })
      boundary = buffer.indexOf('\n\n')
    }
    return frames
  }
  return {
    push(chunk: string) { buffer += chunk; return drain() },
    finish() { buffer += '\n\n'; return drain() },
  }
}
