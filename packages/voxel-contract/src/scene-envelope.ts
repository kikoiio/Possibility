import { applyEdits } from './edits'
import { deserialize, isSerializedVoxelDocument, isSerializedVoxelSpaces, serialize } from './serialize'
import type { SerializedVoxelDocument, SerializedVoxelSpaces } from './serialize'
import { setBlockMut } from './sections'
import type { AssetPlacement, EditOperation, VoxelDocument } from './types'
import type {
  SceneCandidate,
  SceneCompatibilityEnvelope,
  SceneDecodeResult,
  SceneIssue,
  SceneRepairChange,
  StoredSceneDocument,
} from './scene-compatibility'

/** The private key used for a single-space envelope. It is not a user-facing space id. */
export const SINGLE_SPACE_ID = 'single'

type RawDocument = SerializedVoxelDocument | SerializedVoxelSpaces

type DecodeFailure = {
  status: 'missing' | 'corrupt' | 'unsupported'
  issues: SceneIssue[]
}

const clone = <T>(value: T): T => {
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value)) as T
}

function issue(
  status: 'corrupt' | 'unsupported' | 'missing',
  code: string,
  summary: string,
  suggestion: string,
): DecodeFailure {
  return {
    status,
    issues: [{
      id: `scene-envelope:${status}:${code}`,
      code,
      origin: 'existing',
      category: 'format',
      spaceId: null,
      summary,
      suggestion,
      blocking: true,
    }],
  }
}

function parseInput(value: unknown): { raw: unknown; parsed: unknown } | DecodeFailure {
  if (value === undefined || value === null) return issue('missing', 'missing-scene', '场景资料不存在', '请重新加载场景后再试')
  if (typeof value !== 'string') return { raw: value, parsed: value }
  try {
    return { raw: value, parsed: JSON.parse(value) }
  } catch {
    return issue('corrupt', 'invalid-json', '场景资料不是有效 JSON', '保留原资料并从可用场景版本重新加载')
  }
}

function decodeDocument(raw: unknown): VoxelDocument | DecodeFailure {
  if (!isSerializedVoxelDocument(raw)) {
    const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : undefined
    if (record?.format === 'voxel-document' && record.version !== 1) {
      return issue('unsupported', 'unsupported-document-version', '场景文档版本不受支持', '使用支持该版本的场景适配器或保留原版本')
    }
    return issue('corrupt', 'invalid-document-envelope', '场景文档信封不完整或格式损坏', '保留原资料并从可用场景版本重新加载')
  }
  try {
    return deserialize(JSON.stringify(raw))
  } catch (error) {
    return issue('corrupt', 'invalid-document', error instanceof Error ? error.message : '场景文档无法读取', '保留原资料并从可用场景版本重新加载')
  }
}

function hasFailure(value: unknown): value is DecodeFailure {
  return typeof value === 'object' && value !== null && 'status' in value && (value as { status?: unknown }).status !== 'ready'
}

function decodeSpaces(raw: SerializedVoxelSpaces):
  | { spaces: Array<{ spaceId: string; document: VoxelDocument }>; defaultSpaceId: string }
  | DecodeFailure {
  if (!Array.isArray(raw.spaces) || raw.spaces.length === 0) {
    return issue('corrupt', 'missing-spaces', '多空间场景没有可读取的空间', '保留原资料并从可用场景版本重新加载')
  }
  if (typeof raw.defaultSpaceId !== 'string' || raw.defaultSpaceId.length === 0) {
    return issue('corrupt', 'missing-default-space', '多空间场景缺少默认空间', '保留原资料并从可用场景版本重新加载')
  }

  const ids = new Set<string>()
  const spaces: Array<{ spaceId: string; document: VoxelDocument }> = []
  for (const [index, space] of raw.spaces.entries()) {
    if (typeof space !== 'object' || space === null || typeof space.id !== 'string' || space.id.length === 0
      || typeof space.name !== 'string' || space.name.length === 0 || ids.has(space.id)) {
      return issue('corrupt', 'invalid-space-entry', `多空间场景第 ${index + 1} 个空间无效`, '保留原资料并从可用场景版本重新加载')
    }
    ids.add(space.id)
    const document = decodeDocument(space.document)
    if (hasFailure(document)) return document
    spaces.push({ spaceId: space.id, document })
  }
  if (!ids.has(raw.defaultSpaceId)) {
    return issue('corrupt', 'unknown-default-space', '默认空间不存在于空间列表中', '保留原资料并从可用场景版本重新加载')
  }
  return { spaces, defaultSpaceId: raw.defaultSpaceId }
}

function stablePlacementBase(spaceId: string, index: number, placement: AssetPlacement): string {
  const content = `${spaceId}|${index}|${placement.assetId}|${placement.anchor.join(',')}|${placement.rotation}|${placement.seed}`
  let hash = 2166136261
  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `legacy-placement-${index}-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function ensurePlacementIds(spaceId: string, document: VoxelDocument): SceneRepairChange[] {
  if (!document.assetPlacements?.length) return []
  const used = new Set<string>([
    ...document.objects.map((object) => object.id),
    ...document.assetPlacements.flatMap((placement) => placement.id ? [placement.id] : []),
  ])
  const changes: SceneRepairChange[] = []
  const placements = document.assetPlacements.map((placement, index) => {
    if (placement.id) return { ...placement, anchor: [...placement.anchor] as [number, number, number] }
    const base = stablePlacementBase(spaceId, index, placement)
    let id = base
    let suffix = 2
    while (used.has(id)) id = `${base}-${suffix++}`
    used.add(id)
    changes.push({
      id: `assign-placement-id:${spaceId}:${index}`,
      spaceId,
      issueIds: [],
      kind: 'assign-placement-id',
      placementIndex: index,
      placementId: id,
      summary: `为第 ${index + 1} 个资产摆放分配稳定标识`,
    })
    return { ...placement, id, anchor: [...placement.anchor] as [number, number, number] }
  })
  document.assetPlacements = placements
  return changes
}

function envelopeFromRaw(
  raw: RawDocument,
  format: 'single' | 'spaces',
  spaces: Array<{ spaceId: string; document: VoxelDocument }>,
): SceneCompatibilityEnvelope {
  const changes = spaces.flatMap(({ spaceId, document }) => ensurePlacementIds(spaceId, document))
  return {
    original: clone(raw) as StoredSceneDocument,
    spaces: spaces.map(({ spaceId, document }) => ({ spaceId, document: clone(document) })),
    format,
    compatibilityChanges: changes,
  }
}

/**
 * Decode a stored voxel document without rewriting it. The envelope's `original`
 * is a deep snapshot of the input; normalized spaces are independent work copies.
 */
export function decodeSceneCompatibility(document: unknown): SceneDecodeResult | DecodeFailure {
  const input = parseInput(document)
  if (hasFailure(input)) return input
  const raw = input.parsed
  if (isSerializedVoxelDocument(raw)) {
    const decoded = decodeDocument(raw)
    if (hasFailure(decoded)) return decoded
    return { status: 'ready', envelope: envelopeFromRaw(raw, 'single', [{ spaceId: SINGLE_SPACE_ID, document: decoded }]) }
  }
  if (isSerializedVoxelSpaces(raw)) {
    if (raw.version !== 1) return issue('unsupported', 'unsupported-spaces-version', '多空间场景版本不受支持', '使用支持该版本的场景适配器或保留原版本')
    const decoded = decodeSpaces(raw)
    if (hasFailure(decoded)) return decoded
    return { status: 'ready', envelope: envelopeFromRaw(raw, 'spaces', decoded.spaces) }
  }
  if (typeof raw === 'object' && raw !== null && 'format' in raw) {
    return issue('unsupported', 'unsupported-scene-format', '场景表现格式不受当前体素适配器支持', '保留原资料并使用对应表现格式的处理流程')
  }
  return issue('corrupt', 'missing-scene-format', '场景资料缺少可识别的格式标记', '保留原资料并从可用场景版本重新加载')
}

function decodeCurrent(current: StoredSceneDocument): Exclude<SceneDecodeResult, { status: 'corrupt' | 'unsupported' }> | DecodeFailure {
  return decodeSceneCompatibility(current)
}

function targetSpace(
  envelope: SceneCompatibilityEnvelope,
  spaceId: string | undefined,
): { spaceId: string; document: VoxelDocument } | DecodeFailure {
  if (envelope.format === 'single') {
    if (spaceId !== undefined) return issue('corrupt', 'single-space-id', '单空间候选不能声明空间 ID', '移除 spaceId 后重新生成候选')
    return envelope.spaces[0] as { spaceId: string; document: VoxelDocument }
  }
  if (!spaceId) return issue('corrupt', 'missing-space-id', '多空间候选必须声明真实空间 ID', '指定要编辑的空间后重新生成候选')
  const target = envelope.spaces.find((space) => space.spaceId === spaceId)
  if (!target) return issue('corrupt', 'unknown-space-id', `空间 ${spaceId} 不存在`, '使用原场景声明的空间 ID')
  return target
}

function decodeCandidateDocument(value: unknown): VoxelDocument | DecodeFailure {
  if (typeof value === 'string') {
    try { return deserialize(value) } catch (error) {
      return issue('corrupt', 'invalid-candidate-document', error instanceof Error ? error.message : '候选空间无法读取', '重新生成候选')
    }
  }
  return decodeDocument(value)
}

function materializedEnvelope(
  current: SceneCompatibilityEnvelope,
  spaceId: string,
  document: VoxelDocument,
): SceneCompatibilityEnvelope {
  return {
    original: clone(current.original) as StoredSceneDocument,
    spaces: current.spaces.map((space) => ({
      spaceId: space.spaceId,
      document: space.spaceId === spaceId ? clone(document) : clone(space.document),
    })),
    format: current.format,
    compatibilityChanges: clone(current.compatibilityChanges),
  }
}

/** Apply one declared-space candidate in memory; this function never mutates `current`. */
export function materializeSceneCandidate(
  current: StoredSceneDocument,
  candidate: SceneCandidate,
): SceneDecodeResult | DecodeFailure {
  const decoded = decodeCurrent(current)
  if (hasFailure(decoded)) return decoded
  if (decoded.status !== 'ready') return decoded
  const selected = targetSpace(decoded.envelope, candidate.spaceId)
  if (hasFailure(selected)) return selected

  if (candidate.kind === 'operations') {
    try {
      const result = applyEdits(clone(selected.document), clone(candidate.operations) as EditOperation[])
      return {
        status: 'ready',
        envelope: materializedEnvelope(decoded.envelope, selected.spaceId, result.document),
      }
    } catch (error) {
      return issue('corrupt', 'invalid-candidate-operations', error instanceof Error ? error.message : '编辑操作无法应用', '重新生成候选操作')
    }
  }

  const replacement = decodeCandidateDocument(candidate.document)
  if (hasFailure(replacement)) return replacement
  return {
    status: 'ready',
    envelope: materializedEnvelope(decoded.envelope, selected.spaceId, replacement),
  }
}

/**
 * Patch only the serialized fields represented by compatibility changes. Unknown
 * keys and untouched spaces remain byte-for-byte equivalent after JSON parsing.
 */
export function applySceneRepairChangesToRaw(
  original: StoredSceneDocument,
  changes: SceneRepairChange[],
): StoredSceneDocument | DecodeFailure {
  const raw = clone(original) as RawDocument
  const decoded = decodeSceneCompatibility(raw)
  if (hasFailure(decoded) || decoded.status !== 'ready') return decoded as DecodeFailure
  for (const change of changes) {
    const space = decoded.envelope.spaces.find((entry) => entry.spaceId === change.spaceId)
    if (!space) return issue('corrupt', 'unknown-change-space', `变化引用了不存在的空间 ${change.spaceId}`, '重新生成修复变化')
    const targetRaw = raw.format === 'voxel-document'
      ? raw
      : raw.spaces.find((entry) => entry.id === change.spaceId)?.document
    if (!targetRaw) return issue('corrupt', 'unknown-change-space', `变化引用了不存在的空间 ${change.spaceId}`, '重新生成修复变化')
    if (change.kind === 'assign-placement-id') {
      const placement = space.document.assetPlacements?.[change.placementIndex]
      const rawPlacements = targetRaw.assetPlacements
      if (!placement || !rawPlacements?.[change.placementIndex]) return issue('corrupt', 'unknown-placement-index', '变化引用了不存在的资产摆放', '重新生成修复变化')
      rawPlacements[change.placementIndex] = { ...rawPlacements[change.placementIndex], id: change.placementId }
    } else if (change.kind === 'set-block') {
      setBlockMut(space.document, change.at, change.toBlock)
      const serialized = JSON.parse(serialize(space.document)) as SerializedVoxelDocument
      const rawSections = targetRaw.sections as Record<string, unknown>
      const sectionKeys = new Set([...Object.keys(rawSections), ...Object.keys(serialized.sections)])
      for (const sectionKey of sectionKeys) {
        const nextSection = serialized.sections[sectionKey]
        if (!nextSection) {
          delete rawSections[sectionKey]
        } else {
          const priorSection = rawSections[sectionKey]
          rawSections[sectionKey] = typeof priorSection === 'object' && priorSection !== null
            ? { ...(priorSection as Record<string, unknown>), ...nextSection }
            : nextSection
        }
      }
    } else if (change.kind === 'move-asset' || change.kind === 'remove-asset') {
      const placement = space.document.assetPlacements?.find((entry) => entry.id === change.placementId)
      if (!placement || !targetRaw.assetPlacements) return issue('corrupt', 'unknown-placement-id', '变化引用了不存在的资产摆放', '重新生成修复变化')
      const index = space.document.assetPlacements?.findIndex((entry) => entry.id === change.placementId) ?? -1
      if (index < 0 || !targetRaw.assetPlacements[index]) return issue('corrupt', 'unknown-placement-id', '变化引用了不存在的资产摆放', '重新生成修复变化')
      if (change.kind === 'move-asset') {
        targetRaw.assetPlacements[index] = { ...targetRaw.assetPlacements[index], anchor: [change.to.x, change.to.y, change.to.z] }
      } else {
        targetRaw.assetPlacements.splice(index, 1)
      }
    }
  }
  return raw
}
