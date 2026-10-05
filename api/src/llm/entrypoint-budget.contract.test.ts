import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath, URL as NodeURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const srcDir = fileURLToPath(new NodeURL('../', import.meta.url))

function sourceFiles(prefix = ''): string[] {
  return readdirSync(`${srcDir}${prefix}`, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) return sourceFiles(relative)
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [relative] : []
  })
}

function readSource(relative: string): string {
  return readFileSync(`${srcDir}${relative}`, 'utf8')
}

const clientCallFiles = [
  'agent/loop.ts',
  'agent/distill.ts',
  'chapters/generate.ts',
  'engine/director-llm.ts',
  'engine/steps/beat.ts',
  'engine/steps/dialogue.ts',
  'engine/steps/injection.ts',
  'engine/steps/schedule.ts',
  'engine/steps/summary.ts',
  'scene/routes.ts',
  // A1(B68): e2e fixture 的确定性提供者，形状含 complete( 但只在 s02-e2e 显式
  // fixture 模式下注入，从不调用真实 LLM client；已评审，列入清单防止扫描漏报。
  'scenes/e2e-fixture.ts',
  'scenes/routes.ts',
  'scenes/voxel-draft.ts',
  'settings/routes.ts',
  'timelines/routes.ts',
  'voxel/edit-planner.ts',
  'voxel/generate.ts',
  'voxel/projection.ts',
  'voxel/routes.ts',
  'worlds/draft.ts',
  'worlds/routes.ts',
]

const directlyResolvedEntries = [
  'agent/loop.ts',
  'agent/distill.ts',
  'chapters/generate.ts',
  'scene/routes.ts',
  'scenes/routes.ts',
  'scenes/voxel-draft.ts',
  'timelines/routes.ts',
  'voxel/routes.ts',
  'worlds/draft.ts',
  'worlds/routes.ts',
]

const injectedEngineEntries = [
  'engine/director-llm.ts',
  'engine/steps/beat.ts',
  'engine/steps/dialogue.ts',
  'engine/steps/injection.ts',
  'engine/steps/schedule.ts',
  'engine/steps/summary.ts',
]

describe('LLM provider-budget entrypoint contract', () => {
  it('keeps every production client callsite in the reviewed inventory', () => {
    const actual = sourceFiles()
      .filter(relative => relative !== 'llm/client.ts')
      .filter(relative => /\b(?:completeContract|complete|streamChat)\s*\(/.test(readSource(relative)))
      .sort()
    expect(actual).toEqual([...clientCallFiles].sort())
  })

  it('resolves the actual Key source before direct entry calls', () => {
    for (const relative of directlyResolvedEntries) {
      const source = readSource(relative)
      expect(source, relative).toContain('resolveLlmConfig(')
      expect(source, relative).toMatch(/(?:userReservation|worldReservation)\(/)
    }
  })

  it('passes tick-resolved Key source through every engine LLM step', () => {
    const tick = readSource('engine/tick.ts')
    expect(tick).toContain('resolveLlmConfig(')
    expect(tick).toContain('apiKeySource: llmResolution.apiKeySource')
    expect(tick).toContain('apiKeyVerified: llmResolution.verificationValid')

    for (const relative of injectedEngineEntries) {
      expect(readSource(relative), relative).toContain('llmConfigFor(env, opts.llm, opts.reserve)')
    }
  })

  it('resolves source for the connection test and keeps injected voxel helpers behind resolved callers', () => {
    const settings = readSource('settings/routes.ts')
    expect(settings).toContain("apiKeySource: 'personal_global' as const")
    expect(settings).toContain("userReservation(db, userId, budgetFromEnv(c.env), 'connection_test')")

    expect(readSource('voxel/projection.ts')).toContain('llmConfigFor(env, llm, reserve)')
    for (const relative of ['voxel/generate.ts', 'voxel/edit-planner.ts']) {
      const source = readSource(relative)
      expect(source, relative).toContain('deps.complete(messages)')
    }
    for (const relative of ['scenes/routes.ts', 'scenes/voxel-draft.ts']) {
      expect(readSource(relative), relative).toMatch(/complete:\s*(?:messages\s*=>|\(messages\)\s*=>)\s*complete\(config,/)
    }
    // voxel/routes.ts 允许 B68 fixture 提供者兜底在前，但回退分支必须包装已解析的 resolution.config。
    const voxelRoutes = readSource('voxel/routes.ts')
    expect(voxelRoutes, 'voxel/routes.ts').toContain('compatibilityFixturePlannerComplete(c.env)')
    expect(voxelRoutes, 'voxel/routes.ts').toContain('complete: fixtureComplete ?? ((messages) => complete(resolution.config,')
  })
})
