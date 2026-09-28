export interface RequestScope {
  worldId: string
  timelineId: string
  spaceId: string
  generation: number
  requestId: string
}
export type WorldScope = Omit<RequestScope, 'requestId'>

/** Rejects late responses after a world, timeline, space, or generation switch. */
export function matchesRequestScope(current: WorldScope, response: RequestScope): boolean {
  return current.worldId === response.worldId
    && current.timelineId === response.timelineId
    && current.spaceId === response.spaceId
    && current.generation === response.generation
}

export class RequestScopeController {
  private generation = 0
  private scope: Omit<WorldScope, 'generation'>
  private readonly aborters = new Set<AbortController>()

  constructor(initial: Omit<WorldScope, 'generation'>) { this.scope = { ...initial } }

  current(): WorldScope { return { ...this.scope, generation: this.generation } }

  update(next: Omit<WorldScope, 'generation'>): WorldScope {
    const changed = next.worldId !== this.scope.worldId || next.timelineId !== this.scope.timelineId || next.spaceId !== this.scope.spaceId
    if (changed) {
      this.generation++
      for (const aborter of this.aborters) aborter.abort()
      this.aborters.clear()
      this.scope = { ...next }
    }
    return this.current()
  }

  create(requestId: string = crypto.randomUUID()): { scope: RequestScope; controller: AbortController } {
    const controller = new AbortController()
    this.aborters.add(controller)
    controller.signal.addEventListener('abort', () => this.aborters.delete(controller), { once: true })
    return { scope: { ...this.current(), requestId }, controller }
  }

  accepts(response: RequestScope): boolean { return matchesRequestScope(this.current(), response) }
}
