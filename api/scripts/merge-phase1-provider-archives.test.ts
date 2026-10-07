import { describe, expect, it } from 'vitest'
import { mergeProviderArchives } from './merge-phase1-provider-archives'

function archive(id: string, scenarios: string[]) {
  return {
    workflowRunId: id, provider: { model: 'deepseek-v4-pro' }, scope: { replay: false },
    scenarios: scenarios.filter(name => name !== 'original-world-repair').map(name => ({ id: name, valid: true })),
    singleSpace: { saved: scenarios.includes('official-example') },
    repair: { selected: scenarios.includes('original-world-repair'), saved: scenarios.includes('original-world-repair') },
    requests: { reconciled: true, actualProviderRequests: scenarios.length,
      calls: scenarios.map(scenario => ({ scenario, status: 200, usage: null, generatedContent: `response-${id}-${scenario}` })) },
  }
}
describe('recorded provider archive provenance', () => {
  it('keeps cases within a single real source and labels the composite as recorded input', () => {
    const first = archive('100', ['official-example', 'custom-1', 'original-world-repair'])
    const second = archive('101', ['custom-2', 'custom-3', 'original-world-repair'])
    const merged = mergeProviderArchives([first, second])
    expect(merged.sourceScenarioRuns).toEqual({ 'official-example': '100', 'custom-1': '100', 'custom-2': '101', 'custom-3': '101', 'original-world-repair': '101' })
    expect(merged.requests.calls).toHaveLength(5)
    expect(merged.scope.newRealProviderEvidence).toBe(false)
  })
  it('refuses replay as a real-source archive', () => {
    const second = archive('101', ['custom-2', 'custom-3'])
    second.scope.replay = true
    expect(() => mergeProviderArchives([archive('100', ['official-example', 'custom-1', 'original-world-repair']), second])).toThrow('real-provider')
  })
  it('refuses missing cases and incomplete response contents', () => {
    expect(() => mergeProviderArchives([archive('100', ['official-example']), archive('101', ['custom-1'])])).toThrow('Missing successful')
    const first = archive('100', ['official-example', 'custom-1', 'original-world-repair'])
    first.requests.calls[0].generatedContent = ''
    expect(() => mergeProviderArchives([first, archive('101', ['custom-2', 'custom-3'])])).toThrow('Invalid response sequence')
  })
})
