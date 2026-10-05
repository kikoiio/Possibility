// ── 坐标与尺寸 ──────────────────────────────
// x/z 为水平面，y 为高度（向上为正）
import type { WorldEvent } from './events'

export interface VoxelCoord { x: number; y: number; z: number }
export interface VoxelSize { width: number; height: number; depth: number }

// ── 方块注册表（F5, N6）──────────────────────
export interface BlockType {
  id: string                        // 'grass' | 'stone' | 'water' | ...
  name: string                      // 显示名（编辑器面板用）
  textures: {                       // 图集帧名；手绘纹理
    top: string; side: string; bottom?: string
  }
  solid: boolean                    // 参与面剔除与站立
  translucent?: boolean             // 水、玻璃：画但不挡邻居面
  emitsLight?: number               // 0–15，灯笼/窗（F7）
  accumulatesSnow?: boolean         // 顶面可积雪（F9）
  category: 'terrain' | 'structural' | 'decor' | 'fluid' | 'effect'
}

export interface BlockRegistry {
  get(id: string): BlockType | undefined
  list(): BlockType[]
  register(type: BlockType): void   // 主题包通过它注入新方块（N6）
}

// ── 区块存储（F4 性能地基）────────────────────
// 16×16×16 一节，调色板 + 索引数组
export interface ChunkSection {
  palette: string[]                 // 本节出现的方块 id
  indices: Uint16Array              // 4096 个调色板索引
  nonAirCount: number               // 空节直接跳过网格化
}

// 世界 = 稀疏的节集合，键为节坐标
export type SectionKey = string     // `${cx},${cy},${cz}`

// ── 物体与绑定（F2, F15, F18）─────────────────
export interface VoxelObject {
  id: string
  objectType: string                // 仓库条目 id，如 'manor-main-house'
  anchor: VoxelCoord                // 放置原点
  rotation: 0 | 90 | 180 | 270
  label?: string
  binding?:                         // 与现有世界模型对齐
    | { kind: 'location'; locationName: string }
    | { kind: 'person'; personId: string }
}

// 物体的方块不单独存储——放置时把模板方块烙印进网格，
// 物体记录占据的格子集合，用于选中/移动/锁定判定
export interface VoxelObjectCells { objectId: string; cells: VoxelCoord[] }

/** A render-only glTF placement. Missing on legacy documents by design. */
export interface AssetPlacement {
  /** 摆放身份(S2b):place-asset 生成;旧存档缺省,由 ensureAssetPlacementIds 幂等补齐 */
  id?: string
  assetId: string
  anchor: [number, number, number]
  /** Quarter turns clockwise around the vertical axis. */
  rotation: 0 | 1 | 2 | 3
  seed: number
}

export interface LocationBinding {
  name: string                      // '主楼' | '庭院' | '温室'
  objectId: string                  // 绑到哪个物体;S1 起也可是资产摆放(placement)id(GLB 建筑可承载地点)
}

export interface SpaceEntry {       // 多空间（F19）
  spaceId: string
  label: string                     // '进入主楼 →'
  at: VoxelCoord                    // 触发位置
}

// ── 参数化地形与风格包(S3b)────────────────────
export interface TerrainParams {
  seed?: number                     // 缺省时由生成方分配并写入 meta
  elevation?: {
    amplitude?: number              // 起伏振幅(格),0 = 平地;配额上限见 terrain.ts
    scale?: number                  // 噪声水平尺度,越大越平缓
  }
  river?: { enabled?: boolean; width?: number }
  lakes?: { enabled?: boolean; size?: number }
  vegetation?: {
    density?: number                // 0–1 每柱散布概率基数,配额上限见 terrain.ts
    trees?: boolean
    flowers?: boolean
    bushes?: boolean
  }
}

/** 落盘形态:必含 seed */
export type ResolvedTerrainParams = TerrainParams & { seed: number }

export interface TerrainCell { at: VoxelCoord; block: string }

export interface ClampRecord {
  field: string                     // 'vegetation.density' | 'style.preset' | ...
  from: number | string
  to: number | string
}

export interface WorldTerrainMeta {
  params: ResolvedTerrainParams
  clamps: ClampRecord[]
}

export interface StylePackRef {
  preset: string                    // 预设 id;未知 id 夹到默认预设并记录
  tweaks?: {
    fogDensity?: number             // 乘性偏移 [-0.5, +0.5]
    exposure?: number               // 加性偏移 [-0.3, +0.3]
    saturation?: number             // 加性偏移 [-0.3, +0.3]
  }
  clamps?: ClampRecord[]            // style 侧夹取记录(与 terrain 各记各的)
}

// ── 世界文档（F1）─────────────────────────────
export interface VoxelDocument {
  version: 1
  id: string
  theme: string                     // 'mist-manor'，决定方块集与图集
  size: VoxelSize
  sections: Record<SectionKey, ChunkSection>
  objects: VoxelObject[]
  objectCells: VoxelObjectCells[]
  /** Optional vegetation/decoration instances; old saves omit this field. */
  assetPlacements?: AssetPlacement[]
  locations: LocationBinding[]
  spaceEntries: SpaceEntry[]
  lockedObjectIds: string[]
  terrain?: WorldTerrainMeta        // S3b:无此字段 = 非参数化地形世界(旧存档)
  style?: StylePackRef              // S3b:无此字段 = 默认氛围(旧存档)
  events?: WorldEvent[]             // S3b 事件披露:无此字段 = 旧存档,零事件
}

// ── 物体模板（仓库条目）───────────────────────
// 放置时把模板方块烙印进网格
export interface ObjectTemplate {
  objectType: string
  name: string
  // 模板占据的格子（相对 anchor），每格一个方块 id
  cells: Array<{ offset: VoxelCoord; block: string }>
  // 模板内部不可行走的开放腔体（相对 anchor）
  nonWalkableCavities?: VoxelCoord[]
}

// ── 编辑操作（F16, F17 共用）───────────────────
// 用户手动编辑与 AI 对话式编辑产出同一组操作——
// 预览、校验、应用走同一条管线
export type EditOperation =
  | { kind: 'set-block'; at: VoxelCoord; block: string }
  | { kind: 'fill'; from: VoxelCoord; to: VoxelCoord; block: string }
  | { kind: 'place-object'; objectType: string; anchor: VoxelCoord; rotation: 0 | 90 | 180 | 270; objectId?: string; label?: string }
  | { kind: 'move-object'; objectId: string; anchor: VoxelCoord }
  | { kind: 'remove-object'; objectId: string }
  // S2b 资产摆放(F4):GLB 实例的一等公民 op,与方块/物体共用校验-应用管线;
  // 旋转沿用 AssetPlacement 的 0|1|2|3 四分之一圈制式(勿与 VoxelObject 的角度制混)
  | { kind: 'place-asset'; assetId: string; anchor: VoxelCoord; rotation: 0 | 1 | 2 | 3; placementId?: string; seed?: number }
  | { kind: 'move-asset'; placementId: string; anchor: VoxelCoord; rotation?: 0 | 1 | 2 | 3 }  // 原地旋转 = 同 anchor 的移动
  | { kind: 'remove-asset'; placementId: string }

export interface EditResult {
  document: VoxelDocument           // 应用后的新文档（不可变更新）
  changedSections: SectionKey[]     // 引擎只重建这些节（F4）
  affectedObjectIds: string[]
}

// ── 校验（F1, N10）────────────────────────────
export interface ValidationIssue {
  code: 'out-of-bounds' | 'unknown-block' | 'floating-object'
      | 'object-overlap' | 'location-unbound' | 'locked-violation'
      // S2b 可行走性（F5）：净高 / 连通 / 照明 / 高差突变 / 地面缺口
      | 'walk-clearance' | 'walk-connectivity' | 'walk-lighting'
      | 'walk-stairs' | 'walk-gap'
      // S3b 元数据(F6):地形/风格包 meta 形状非法
      | 'invalid-meta'
      // S2b 资产摆放(F4):assetId 不在清单 / placementId 不存在;占地冲突或悬空
      | 'unknown-asset' | 'asset-overlap'
  message: string
  at?: VoxelCoord
}

export interface Validator {
  validateDocument(doc: VoxelDocument): ValidationIssue[]
  validateEdit(doc: VoxelDocument, ops: EditOperation[]): ValidationIssue[]
}
