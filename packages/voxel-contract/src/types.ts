// ── 坐标与尺寸 ──────────────────────────────
// x/z 为水平面，y 为高度（向上为正）
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

export interface LocationBinding {
  name: string                      // '主楼' | '庭院' | '温室'
  objectId: string                  // 绑到哪个物体
}

export interface SpaceEntry {       // 多空间（F19）
  spaceId: string
  label: string                     // '进入主楼 →'
  at: VoxelCoord                    // 触发位置
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
  locations: LocationBinding[]
  spaceEntries: SpaceEntry[]
  lockedObjectIds: string[]
}

// ── 物体模板（仓库条目）───────────────────────
// 放置时把模板方块烙印进网格
export interface ObjectTemplate {
  objectType: string
  name: string
  // 模板占据的格子（相对 anchor），每格一个方块 id
  cells: Array<{ offset: VoxelCoord; block: string }>
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

export interface EditResult {
  document: VoxelDocument           // 应用后的新文档（不可变更新）
  changedSections: SectionKey[]     // 引擎只重建这些节（F4）
  affectedObjectIds: string[]
}

// ── 校验（F1, N10）────────────────────────────
export interface ValidationIssue {
  code: 'out-of-bounds' | 'unknown-block' | 'floating-object'
      | 'object-overlap' | 'location-unbound' | 'locked-violation'
  message: string
  at?: VoxelCoord
}

export interface Validator {
  validateDocument(doc: VoxelDocument): ValidationIssue[]
  validateEdit(doc: VoxelDocument, ops: EditOperation[]): ValidationIssue[]
}
