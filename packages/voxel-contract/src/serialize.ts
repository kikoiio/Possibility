import { SECTION_VOLUME } from './sections'
import type {
  ChunkSection, LocationBinding, SpaceEntry, StylePackRef, VoxelDocument, VoxelObject, VoxelObjectCells,
  VoxelSize, WorldTerrainMeta,
} from './types'

export class VoxelDeserializeError extends Error {
  constructor(public readonly reason: string) {
    super(`invalid voxel document: ${reason}`)
    this.name = 'VoxelDeserializeError'
  }
}

// ── base64（零依赖，浏览器 / Node / Worker 通用）─────
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_REV = new Map([...B64].map((c, i) => [c, i]))

function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2]
    out += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)]
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | ((c ?? 0) >> 6)] : '='
    out += i + 2 < bytes.length ? B64[c & 63] : '='
  }
  return out
}

function base64ToBytes(raw: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length % 4 !== 0) {
    throw new VoxelDeserializeError('malformed base64 payload')
  }
  const out = new Uint8Array((raw.length / 4) * 3 - (raw.endsWith('==') ? 2 : raw.endsWith('=') ? 1 : 0))
  let o = 0
  for (let i = 0; i < raw.length; i += 4) {
    const n = ((B64_REV.get(raw[i]) ?? 0) << 18) | ((B64_REV.get(raw[i + 1]) ?? 0) << 12)
      | ((B64_REV.get(raw[i + 2]) ?? 0) << 6) | (B64_REV.get(raw[i + 3]) ?? 0)
    if (o < out.length) out[o++] = (n >> 16) & 0xff
    if (o < out.length) out[o++] = (n >> 8) & 0xff
    if (o < out.length) out[o++] = n & 0xff
  }
  return out
}

function u16ToBase64(data: Uint16Array): string {
  return bytesToBase64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
}

function base64ToU16(raw: string): Uint16Array {
  const bytes = base64ToBytes(raw)
  if (bytes.byteLength !== SECTION_VOLUME * 2) {
    throw new VoxelDeserializeError(`section indices must be ${SECTION_VOLUME * 2} bytes, got ${bytes.byteLength}`)
  }
  const copy = new Uint8Array(bytes) // 保证 2 字节对齐
  return new Uint16Array(copy.buffer)
}

interface SerializedSection { palette: string[]; indices: string; nonAirCount: number }

/** 序列化信封的 JSON 形态（存储/传输层的不透明文档类型） */
export interface SerializedVoxelDocument {
  format: 'voxel-document'
  version: 1
  id: string
  theme: string
  size: VoxelSize
  sections: Record<string, SerializedSection>
  objects: VoxelObject[]
  objectCells: VoxelObjectCells[]
  locations: LocationBinding[]
  spaceEntries: SpaceEntry[]
  lockedObjectIds: string[]
  /** S3b:可选元数据,缺省不产出该键(N2) */
  terrain?: WorldTerrainMeta
  style?: StylePackRef
}

/** 服务端/客户端共用的格式探测（与 2D SceneDocument 区分） */
export function isSerializedVoxelDocument(value: unknown): value is SerializedVoxelDocument {
  if (typeof value !== 'object' || value === null) return false
  const doc = value as Record<string, unknown>
  return doc.format === 'voxel-document' && doc.version === 1
}

/** 多空间体素场景包（F19）：一个世界若干个空间，各自一份体素文档（对应 2D SceneDocumentV2 的角色） */
export interface SerializedVoxelSpace { id: string; name: string; document: SerializedVoxelDocument }
export interface SerializedVoxelSpaces {
  format: 'voxel-spaces'
  version: 1
  defaultSpaceId: string
  spaces: SerializedVoxelSpace[]
}

export function isSerializedVoxelSpaces(value: unknown): value is SerializedVoxelSpaces {
  if (typeof value !== 'object' || value === null) return false
  const doc = value as Record<string, unknown>
  return doc.format === 'voxel-spaces' && doc.version === 1 && Array.isArray(doc.spaces)
}

/** 序列化：JSON 信封 + 节数据 base64 */
export function serialize(doc: VoxelDocument): string {
  const sections: Record<string, SerializedSection> = {}
  for (const [key, section] of Object.entries(doc.sections)) {
    sections[key] = { palette: section.palette, indices: u16ToBase64(section.indices), nonAirCount: section.nonAirCount }
  }
  const envelope: SerializedVoxelDocument = {
    format: 'voxel-document',
    version: doc.version,
    id: doc.id,
    theme: doc.theme,
    size: doc.size,
    sections,
    objects: doc.objects,
    objectCells: doc.objectCells,
    locations: doc.locations,
    spaceEntries: doc.spaceEntries,
    lockedObjectIds: doc.lockedObjectIds,
    ...(doc.terrain ? { terrain: doc.terrain } : {}),
    ...(doc.style ? { style: doc.style } : {}),
  }
  return JSON.stringify(envelope)
}

function assert(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new VoxelDeserializeError(reason)
}

/** 反序列化：严格校验，坏数据抛带原因的 VoxelDeserializeError */
export function deserialize(raw: string): VoxelDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new VoxelDeserializeError('not valid JSON')
  }
  assert(typeof parsed === 'object' && parsed !== null, 'root must be an object')
  const doc = parsed as Record<string, unknown>
  assert(doc.format === 'voxel-document', `unknown format '${String(doc.format)}'`)
  assert(doc.version === 1, `unsupported version ${String(doc.version)}`)
  assert(typeof doc.id === 'string' && doc.id.length > 0, 'id must be a non-empty string')
  assert(typeof doc.theme === 'string' && doc.theme.length > 0, 'theme must be a non-empty string')
  const size = doc.size as Record<string, unknown>
  assert(size && Number.isInteger(size.width) && Number.isInteger(size.height) && Number.isInteger(size.depth)
    && (size.width as number) > 0 && (size.height as number) > 0 && (size.depth as number) > 0,
    'size must have positive integer width/height/depth')
  assert(typeof doc.sections === 'object' && doc.sections !== null, 'sections must be an object')

  const sections: Record<string, ChunkSection> = {}
  for (const [key, rawSection] of Object.entries(doc.sections as Record<string, unknown>)) {
    assert(/^\d+,\d+,\d+$/.test(key), `malformed section key '${key}'`)
    const s = rawSection as Record<string, unknown>
    assert(Array.isArray(s.palette) && s.palette.every((p: unknown) => typeof p === 'string'), `section ${key}: palette must be a string array`)
    assert(s.palette.length >= 1 && s.palette.length <= 65536, `section ${key}: palette length out of range`)
    assert(typeof s.indices === 'string', `section ${key}: indices must be a base64 string`)
    const indices = base64ToU16(s.indices)
    for (let i = 0; i < indices.length; i++) {
      assert(indices[i] < s.palette.length, `section ${key}: index ${indices[i]} out of palette range`)
    }
    assert(Number.isInteger(s.nonAirCount) && (s.nonAirCount as number) >= 0 && (s.nonAirCount as number) <= SECTION_VOLUME,
      `section ${key}: nonAirCount out of range`)
    sections[key] = { palette: [...(s.palette as string[])], indices, nonAirCount: s.nonAirCount as number }
  }

  for (const field of ['objects', 'objectCells', 'locations', 'spaceEntries', 'lockedObjectIds'] as const) {
    assert(Array.isArray(doc[field]), `${field} must be an array`)
  }

  // S3b 元数据:存在时做形状校验,缺省不产出该键(旧存档无损,N1/N2)
  let terrain: WorldTerrainMeta | undefined
  if (doc.terrain !== undefined) {
    const t = doc.terrain as Record<string, unknown>
    assert(typeof t === 'object' && t !== null, 'terrain must be an object')
    const params = t.params as Record<string, unknown>
    assert(typeof params === 'object' && params !== null, 'terrain.params must be an object')
    assert(Number.isInteger(params.seed), 'terrain.params.seed must be an integer')
    assert(Array.isArray(t.clamps), 'terrain.clamps must be an array')
    terrain = t as unknown as WorldTerrainMeta
  }
  let style: StylePackRef | undefined
  if (doc.style !== undefined) {
    const s = doc.style as Record<string, unknown>
    assert(typeof s === 'object' && s !== null, 'style must be an object')
    assert(typeof s.preset === 'string' && s.preset.length > 0, 'style.preset must be a non-empty string')
    style = s as unknown as StylePackRef
  }

  return {
    version: 1,
    id: doc.id,
    theme: doc.theme,
    size: { width: size.width as number, height: size.height as number, depth: size.depth as number },
    sections,
    objects: doc.objects as VoxelDocument['objects'],
    objectCells: doc.objectCells as VoxelDocument['objectCells'],
    locations: doc.locations as VoxelDocument['locations'],
    spaceEntries: doc.spaceEntries as VoxelDocument['spaceEntries'],
    lockedObjectIds: doc.lockedObjectIds as string[],
    ...(terrain ? { terrain } : {}),
    ...(style ? { style } : {}),
  }
}
