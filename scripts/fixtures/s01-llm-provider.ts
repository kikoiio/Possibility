export default {
  async fetch(request: Request) {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '这是来自隔离验收模型的确定性回复。' } }] })}\n\n`))
        setTimeout(() => {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        }, 4_000)
      },
    })
    return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
  },
}
