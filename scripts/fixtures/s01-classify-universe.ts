import { createDb } from '../../api/src/db/client'
import { assessAndUpgradeUniverse } from '../../api/src/world-state/classification'

interface Env { DB: D1Database; S01_CLASSIFY_TOKEN: string }

export default {
  async fetch(request: Request, env: Env) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/classify') {
      return new Response('not found', { status: 404 })
    }
    if (request.headers.get('authorization') !== `Bearer ${env.S01_CLASSIFY_TOKEN}`) {
      return new Response('unauthorized', { status: 401 })
    }
    const result = await assessAndUpgradeUniverse(createDb(env.DB), 's01-world', 's01-main')
    return Response.json({ level: result.after.level, assessedVersion: result.after.assessedVersion,
      baselineVersion: result.after.baselineVersion, reasonCodes: result.after.reasonCodes,
      upgraded: result.plan !== null })
  },
}
