/**
 * Verify a deployed runtime keeps advancing while away, then honors pause/resume.
 *
 * Usage:
 *   DEPLOYMENT_API_URL=https://example.workers.dev \
 *   DEPLOYMENT_USERNAME=... DEPLOYMENT_PASSWORD=... \
 *   DEPLOYMENT_WORLD_ID=... DEPLOYMENT_WAIT_MS=30000 \
 *   npx tsx scripts/verify-deployment-journey.ts
 *
 * The script uses existing auth, world, and engine status routes. It does not
 * create test records or require a database connection. It advances a running
 * world naturally, then pauses and resumes it; use a dedicated test world.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const apiUrl = (process.env.DEPLOYMENT_API_URL ?? 'http://localhost:8787').replace(/\/$/, '')
const username = process.env.DEPLOYMENT_USERNAME
const password = process.env.DEPLOYMENT_PASSWORD
const suppliedToken = process.env.DEPLOYMENT_TOKEN
const requestedWorldId = process.env.DEPLOYMENT_WORLD_ID
const requestedTimelineId = process.env.DEPLOYMENT_TIMELINE_ID
const waitMs = Math.max(0, Number.parseInt(process.env.DEPLOYMENT_WAIT_MS ?? '0', 10) || 0)
const evidencePath = resolve(process.env.DEPLOYMENT_EVIDENCE_PATH ??
  `./artifacts/deployment-journey-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null

interface StepEvidence {
  at: string
  status: number
  body: Json
}

interface JourneyEvidence {
  ok: boolean
  startedAt: string
  finishedAt: string
  apiUrl: string
  waitMs: number
  worldId?: string
  timelineId?: string
  steps: Record<string, StepEvidence>
  assertions: Record<string, boolean>
  error?: string
}

const steps: Record<string, StepEvidence> = {}
const assertions: Record<string, boolean> = {}
let authToken: string | null = null
let pausedWorldId: string | null = null

function now(): string { return new Date().toISOString() }

async function request(name: string, path: string, init: RequestInit = {}, token?: string): Promise<Json> {
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const response = await fetch(`${apiUrl}${path}`, { ...init, headers })
  const text = await response.text()
  let body: Json
  try { body = text ? JSON.parse(text) as Json : null } catch { body = text }
  steps[name] = { at: now(), status: response.status, body }
  if (!response.ok) throw new Error(`${name} failed (${response.status}): ${text.slice(0, 240)}`)
  return body
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stateFingerprint(body: Json | undefined): { simNow: unknown; events: string[]; facts: string[] } {
  const root = object(body)
  const events = Array.isArray(root.events) ? root.events : []
  const facts = Array.isArray(root.currentFacts) ? root.currentFacts : []
  return {
    simNow: root.simNow,
    events: events.map((event) => object(event).id).filter((id): id is string => typeof id === 'string').sort(),
    facts: facts.map((fact) => object(fact).id).filter((id): id is string => typeof id === 'string').sort(),
  }
}

function recordAssertion(name: string, value: boolean): void {
  assertions[name] = value
  if (!value) throw new Error(`assertion failed: ${name}`)
}

const startedAt = now()
let result: JourneyEvidence | undefined
try {
  if (waitMs < 30_000) throw new Error('set DEPLOYMENT_WAIT_MS to at least 30000 to verify background progress')
  if (!suppliedToken && (!username || !password)) {
    throw new Error('set DEPLOYMENT_TOKEN or DEPLOYMENT_USERNAME and DEPLOYMENT_PASSWORD')
  }

  await request('health', '/api/health')
  const login = suppliedToken ? null : object(await request('login', '/api/auth/login', {
    method: 'POST', body: JSON.stringify({ username, password }),
  }))
  const token = suppliedToken ?? (typeof login?.token === 'string' ? login.token : null)
  if (!token) throw new Error('login response did not include a token')
  authToken = token

  const statusBefore = object(await request('statusBefore', '/api/engine/status', {}, token))
  const worlds = object(await request('worldsBefore', '/api/worlds', {}, token)).worlds
  if (!Array.isArray(worlds)) throw new Error('world list response did not include worlds[]')
  const world = (requestedWorldId
    ? worlds.find((candidate) => object(candidate).id === requestedWorldId)
    : worlds.find((candidate) => object(candidate).status === 'running'))
  if (!world) throw new Error(requestedWorldId ? `world not found: ${requestedWorldId}` : 'no running world found')
  const worldObject = object(world)
  const worldId = String(worldObject.id)
  const statusWorld = Array.isArray(statusBefore.worlds)
    ? object(statusBefore.worlds.find((candidate) => object(candidate).id === worldId)) : {}
  const statusTimelines = Array.isArray(statusWorld.timelines) ? statusWorld.timelines : []
  const activeTimeline = statusTimelines.find((candidate) => object(candidate).status === 'active')
  const timelineId = requestedTimelineId ?? (typeof object(activeTimeline).id === 'string' ? String(object(activeTimeline).id) : undefined)
  if (!timelineId) throw new Error(`no active timeline found for world: ${worldId}`)
  const beforePath = `/api/worlds/${encodeURIComponent(worldId)}/state${timelineId ? `?timelineId=${encodeURIComponent(timelineId)}` : ''}`
  const stateBefore = await request('stateBeforeLeave', beforePath, {}, token)
  const beforeFingerprint = stateFingerprint(stateBefore)
  result = {
    ok: false, startedAt, finishedAt: now(), apiUrl, waitMs, worldId, timelineId,
    steps, assertions,
  }

  recordAssertion('engineStatusVisible', Object.prototype.hasOwnProperty.call(statusBefore, 'engine'))
  recordAssertion('worldWasRunning', worldObject.status === 'running')

  // Simulate leaving the world while its scheduler runs naturally.
  await new Promise(resolveWait => setTimeout(resolveWait, waitMs))
  const stateReturnRunning = await request('stateAfterLeave', beforePath, {}, token)
  const awayFingerprint = stateFingerprint(stateReturnRunning)
  recordAssertion('worldAdvancedWhileAway',
    beforeFingerprint.simNow !== awayFingerprint.simNow
    || JSON.stringify(beforeFingerprint.events) !== JSON.stringify(awayFingerprint.events)
    || JSON.stringify(beforeFingerprint.facts) !== JSON.stringify(awayFingerprint.facts))

  await request('pause', `/api/worlds/${encodeURIComponent(worldId)}/pause`, { method: 'POST' }, token)
  pausedWorldId = worldId
  const statusAway = object(await request('statusAfterPause', '/api/engine/status', {}, token))
  const worldAway = Array.isArray(statusAway.worlds)
    ? object(statusAway.worlds.find((candidate) => object(candidate).id === worldId)) : {}
  recordAssertion('pauseReasonRecorded', worldAway.status === 'paused' && worldAway.pauseReason === 'manual')

  const stateAtPause = await request('stateAtPause', beforePath, {}, token)
  const pauseFingerprint = stateFingerprint(stateAtPause)
  await new Promise(resolveWait => setTimeout(resolveWait, waitMs))
  const stateWhilePaused = await request('stateWhilePaused', beforePath, {}, token)
  const pausedFingerprint = stateFingerprint(stateWhilePaused)
  recordAssertion('simTimeFrozenWhilePaused', pauseFingerprint.simNow === pausedFingerprint.simNow)
  recordAssertion('eventsRetained', JSON.stringify(pauseFingerprint.events) === JSON.stringify(pausedFingerprint.events))
  recordAssertion('factsRetained', JSON.stringify(pauseFingerprint.facts) === JSON.stringify(pausedFingerprint.facts))

  await request('resume', `/api/worlds/${encodeURIComponent(worldId)}/resume`, { method: 'POST' }, token)
  const statusAfterResume = object(await request('statusAfterResume', '/api/engine/status', {}, token))
  const worldResumed = Array.isArray(statusAfterResume.worlds)
    ? object(statusAfterResume.worlds.find((candidate) => object(candidate).id === worldId)) : {}
  recordAssertion('resumeClearsStopReason', worldResumed.status === 'running' && worldResumed.pauseReason === null)
  pausedWorldId = null
  result.ok = true
} catch (error) {
  // Never leave a production world paused because an evidence assertion failed.
  if (pausedWorldId && authToken) {
    try {
      await request('resumeCleanup', `/api/worlds/${encodeURIComponent(pausedWorldId)}/resume`, { method: 'POST' }, authToken)
      pausedWorldId = null
    } catch {
      // Preserve the original assertion error in the report; cleanup failure is
      // visible as a non-200 resumeCleanup step.
    }
  }
  result = result ?? { ok: false, startedAt, finishedAt: now(), apiUrl, waitMs, steps, assertions }
  result.error = error instanceof Error ? error.message : String(error)
}

if (!result) result = { ok: false, startedAt, finishedAt: now(), apiUrl, waitMs, steps, assertions,
  error: 'verification did not produce a result' }
result.finishedAt = now()
mkdirSync(dirname(evidencePath), { recursive: true })
writeFileSync(evidencePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ ok: result.ok, evidencePath, assertions: result.assertions }, null, 2))
if (!result.ok) process.exitCode = 1
