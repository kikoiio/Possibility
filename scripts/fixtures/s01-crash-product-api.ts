import app from '../../api/src/index'

interface Env {
  DB: D1Database
  CRASH_FIXTURE_SECRET: string
  [key: string]: unknown
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.headers.get('x-s01-provider-crash') === env.CRASH_FIXTURE_SECRET) {
      const payload = await request.clone().json() as { requestId?: string }
      if (!payload.requestId) return new Response('requestId required', { status: 400 })
      const upstream = globalThis.fetch.bind(globalThis)
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const pendingProviderCall = upstream(input, init)
        await env.DB.prepare(`UPDATE scene_requests SET heartbeat_at = ? WHERE id = ? AND status = 'pending'`)
          .bind(Date.now(), payload.requestId).run()
        // The product API has already reserved its scene request before it
        // reaches the provider. Leave the provider fetch in flight, then let
        // Cloudflare terminate this same API invocation on its CPU limit.
        while (true) { /* deliberate runtime failure injection */ }
        return pendingProviderCall
      })
    }
    return app.fetch(request, env as never, ctx)
  },
}
