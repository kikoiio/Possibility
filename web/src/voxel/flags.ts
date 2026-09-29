import {
  deserialize, isSerializedVoxelDocument, isSerializedVoxelSpaces,
  type SerializedVoxelSpaces, type VoxelDocument,
} from '@possibility/voxel-contract'

/** 体素渲染特性开关（T30）：?voxel=1 或 localStorage possibility:flag:voxel=1；验收后随 T37 移除 */
export function isVoxelEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (new URLSearchParams(window.location.search).get('voxel') === '1') return true
    return window.localStorage.getItem('possibility:flag:voxel') === '1'
  } catch {
    return false
  }
}

/** 服务端文档是否为体素格式（序列化信封，与 2D SceneDocument 区分） */
export function isVoxelPayload(doc: unknown): boolean {
  return isSerializedVoxelDocument(doc)
}

/** 解析服务端返回的体素文档（已反序列化对象原样返回；信封 JSON 走 deserialize 校验） */
export function parseVoxelDocument(doc: unknown): VoxelDocument | null {
  if (!isVoxelPayload(doc)) return null
  try {
    return deserialize(JSON.stringify(doc))
  } catch {
    return null
  }
}

/** 解析多空间体素场景包（F19；与 2D SceneDocumentV2 对应） */
export function parseVoxelSpaces(doc: unknown): SerializedVoxelSpaces | null {
  return isSerializedVoxelSpaces(doc) && doc.spaces.length > 0 ? doc : null
}
