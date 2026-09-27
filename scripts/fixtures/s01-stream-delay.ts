/** Controlled SSE frame that pauses after half its JSON payload has entered the parser buffer. */
export function createS01StreamDelayFixture(frame: Record<string, unknown>) {
  const encoded = `data: ${JSON.stringify(frame)}\n\n`
  const midpoint = Math.max(1, Math.floor(encoded.length / 2))
  let release!: (chunk: string) => void
  let reject!: (error: Error) => void
  let released = false
  const remainder = new Promise<string>((resolve, rejectPromise) => { release = resolve; reject = rejectPromise })
  return {
    firstChunk: encoded.slice(0, midpoint),
    async *chunks() {
      yield encoded.slice(0, midpoint)
      yield await remainder
    },
    release() {
      if (released) throw new Error('S01 delayed frame was already released')
      released = true
      release(encoded.slice(midpoint))
    },
    fail() {
      if (released) throw new Error('S01 delayed frame was already released')
      released = true
      reject(new Error('S01 delayed frame fixture failed'))
    },
  }
}
