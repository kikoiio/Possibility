import * as THREE from 'three'
import type { BlockRegistry, VoxelCoord, VoxelDocument } from '@possibility/voxel-contract'
import { getBlock, getObjectTemplate, rotatedOffsets } from '@possibility/voxel-contract'
import { findPath, nearestStandable } from './pathfinding'
import type { WorldModel } from './world-model'

export interface ResidentRenderState {
  personId: string
  name?: string
  /** 当前所在格（首次同步时的放置点） */
  at: VoxelCoord
  /** 目的地；与当前位置不同则寻路行走，到达后停驻 */
  destination?: VoxelCoord | null
  /** 活动标签（产品层展示用，引擎只透传并据此匹配有限行为姿态） */
  activity?: string
  colorHint?: number
}

// ── V1 家具活动点与有限行为表现 ─────────────────────────
// 坐下/阅读必须有真实对象依据(长凳/书架的活动点),交谈必须有真实居民在旁;
// 无依据一律保持默认站立,不虚构姿态。真实活动投影后续由 D3 提供,
// 这里只消费 activity 标签关键词 + 世界文档对象。

export interface ActivityAnchor {
  kind: 'seat' | 'reading'
  objectId: string
  objectType: string
  /** 使用点：座位=坐面板所在格；阅读=书架前可站立格 */
  cell: VoxelCoord
  /** 面朝方向（水平单位向量，轴对齐） */
  facing: { x: number; z: number }
}

/** 提供座位的对象类型（模板含可坐水平面） */
const SEAT_OBJECTS = new Set(['bench'])
/** 提供阅读位的对象类型 */
const READING_OBJECTS = new Set(['bookshelf'])

/** 与 rotatedOffsets 相同的旋转约定旋转一个水平方向向量 */
function rotateFacing(fx: number, fz: number, rotation: 0 | 90 | 180 | 270): { x: number; z: number } {
  switch (rotation) {
    case 90: return { x: -fz, z: fx }
    case 180: return { x: -fx, z: -fz }
    case 270: return { x: fz, z: -fx }
    default: return { x: fx, z: fz }
  }
}

/**
 * 从世界文档的对象记录解析活动点：
 * - 长凳 → 每格坐面板一个 seat 锚点（面朝长轴垂向，约定 rotation 0 时朝 +z）；
 * - 书架 → 架前（四邻中自身与头顶均可通过的非架体格）reading 锚点，面朝书架。
 * 只读文档与方块注册表，纯函数，可单测。
 */
export function findActivityAnchors(doc: VoxelDocument, registry: BlockRegistry): ActivityAnchor[] {
  const anchors: ActivityAnchor[] = []
  for (const obj of doc.objects ?? []) {
    const isSeat = SEAT_OBJECTS.has(obj.objectType)
    const isReading = READING_OBJECTS.has(obj.objectType)
    if (!isSeat && !isReading) continue
    const template = getObjectTemplate(obj.objectType)
    if (!template) continue
    const offsets = rotatedOffsets(template.cells.map((c) => c.offset), obj.rotation)
    const cells = offsets.map((o) => ({ x: obj.anchor.x + o.x, y: obj.anchor.y + o.y, z: obj.anchor.z + o.z }))
    if (isSeat) {
      // 坐面 = 模板最底层格（面板），坐者站上面板顶；朝向取长轴垂向
      const baseY = Math.min(...cells.map((c) => c.y))
      const facing = rotateFacing(0, 1, obj.rotation)
      for (const cell of cells) {
        if (cell.y !== baseY) continue
        anchors.push({ kind: 'seat', objectId: obj.id, objectType: obj.objectType, cell, facing })
      }
      continue
    }
    // 书架:底层格四邻中「非架体、自身与头顶可通过」的格子为阅读位,面朝最近的架体格
    const occupied = new Set(cells.map((c) => `${c.x},${c.y},${c.z}`))
    const baseY = Math.min(...cells.map((c) => c.y))
    const seen = new Set<string>()
    const passable = (at: VoxelCoord): boolean => {
      const self = registry.get(getBlock(doc, at))
      if (self?.solid) return false
      const above = registry.get(getBlock(doc, { x: at.x, y: at.y + 1, z: at.z }))
      if (above?.solid) return false
      return true
    }
    for (const cell of cells) {
      if (cell.y !== baseY) continue
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const at = { x: cell.x + dx, y: cell.y, z: cell.z + dz }
        const key = `${at.x},${at.y},${at.z}`
        if (occupied.has(key) || seen.has(key)) continue
        seen.add(key)
        if (!passable(at)) continue
        anchors.push({
          kind: 'reading',
          objectId: obj.id,
          objectType: obj.objectType,
          cell: at,
          facing: { x: -dx, z: -dz }, // 面朝架体
        })
      }
    }
  }
  return anchors
}

/** 活动标签 → 有限行为意图（关键词匹配；真实活动投影由 D3 接入后替换） */
export type ActivityIntent = 'sit' | 'read' | 'talk'
const SIT_RE = /坐|歇|休息|乘凉|小坐|sit|rest|relax|lunch/i
const READ_RE = /读|看书|阅读|翻阅|读书|read|book|study|research|write/i
const TALK_RE = /谈|聊|说话|交谈|闲话|商量|talk|chat|speak|conversation/i
export function activityIntent(activity?: string): ActivityIntent | null {
  if (!activity) return null
  if (SIT_RE.test(activity)) return 'sit'
  if (READ_RE.test(activity)) return 'read'
  if (TALK_RE.test(activity)) return 'talk'
  return null
}

/** 居民当前姿态；basis 记录真实依据（seat/read=对象 id，talk=对方 personId） */
export type ResidentPose =
  | { kind: 'sit'; basis: string; cell: VoxelCoord; facing: { x: number; z: number } }
  | { kind: 'read'; basis: string; cell: VoxelCoord; facing: { x: number; z: number } }
  | { kind: 'talk'; basis: string }

/** 姿态匹配半径（活动点/谈话对象离居民位置超过此距离不算有依据） */
const POSE_BASIS_RADIUS = 3

// 12 色盘（FNV-1a 哈希取色，对 UUID 分布稳定）
const PALETTE = [
  0xc95d63, 0xd98e4a, 0xd9b84a, 0x8fb14a, 0x4ab17a, 0x4ab1a5,
  0x4a8fb1, 0x4a6ab1, 0x6a5acd, 0x9a4ab1, 0xb14a8f, 0x8d6e63,
]

function colorFor(personId: string): number {
  let h = 2166136261
  for (let i = 0; i < personId.length; i++) {
    h ^= personId.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return PALETTE[Math.abs(h) % PALETTE.length]
}

const WALK_SPEED = 2.2 // 格/秒

function box(w: number, h: number, d: number, color: number, x = 0, y = 0, z = 0): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color }))
  mesh.position.set(x, y, z)
  return mesh
}

// V1 人物比例:总高 1.70(玩家 1.8、眼高 1.62 同量级),腿/躯干/头 ≈ 0.72/0.62/0.36
const LEG_TOP = 0.72     // 髋部(腿旋转轴)高度
const ARM_TOP = 1.28     // 肩部(臂旋转轴)高度

/** 方块小人：盒体拼装，程序化摆臂/迈步（O8：不做骨骼系统） */
function buildFigure(color: number): { group: THREE.Group; leftArm: THREE.Mesh; rightArm: THREE.Mesh; leftLeg: THREE.Mesh; rightLeg: THREE.Mesh } {
  const group = new THREE.Group()
  const darker = new THREE.Color(color).multiplyScalar(0.72).getHex()
  const skin = 0xe8c39a
  const body = box(0.5, 0.62, 0.28, color, 0, LEG_TOP + 0.31, 0)
  const head = box(0.34, 0.36, 0.32, skin, 0, LEG_TOP + 0.62 + 0.18, 0)
  const leftArm = box(0.13, 0.58, 0.13, darker, -0.315, ARM_TOP - 0.29, 0)
  const rightArm = box(0.13, 0.58, 0.13, darker, 0.315, ARM_TOP - 0.29, 0)
  const leftLeg = box(0.16, LEG_TOP, 0.16, 0x3a3f4a, -0.13, LEG_TOP / 2, 0)
  const rightLeg = box(0.16, LEG_TOP, 0.16, 0x3a3f4a, 0.13, LEG_TOP / 2, 0)
  // 四肢以顶端为旋转轴心
  for (const [limb, topY] of [[leftArm, ARM_TOP], [rightArm, ARM_TOP], [leftLeg, LEG_TOP], [rightLeg, LEG_TOP]] as const) {
    limb.geometry.translate(0, -(topY - limb.position.y), 0)
    limb.position.y = topY
  }
  group.add(body, head, leftArm, rightArm, leftLeg, rightLeg)
  return { group, leftArm, rightArm, leftLeg, rightLeg }
}

interface ResidentEntry {
  figure: ReturnType<typeof buildFigure>
  state: ResidentRenderState
  position: THREE.Vector3
  path: VoxelCoord[] | null
  pathIndex: number
  walkPhase: number
  moving: boolean
  /** V1:当前姿态(无依据为 null);行走中恒为 null */
  pose: ResidentPose | null
  /** 姿态动画相位 */
  posePhase: number
}

/** 居民角色渲染：按活动在地点间寻路行走、走/停动画、点击可选中（F12） */
export class ResidentRenderer {
  private residents = new Map<string, ResidentEntry>()

  constructor(
    private scene: THREE.Scene,
    private world: WorldModel,
    private registry: BlockRegistry,
  ) {}

  syncResidents(states: ResidentRenderState[]): void {
    const seen = new Set<string>()
    for (const state of states) {
      seen.add(state.personId)
      let entry = this.residents.get(state.personId)
      let isNew = false
      if (!entry) {
        isNew = true
        const figure = buildFigure(state.colorHint ?? colorFor(state.personId))
        const stand = nearestStandable(this.world, this.registry, state.at) ?? state.at
        const position = new THREE.Vector3(stand.x + 0.5, stand.y, stand.z + 0.5)
        figure.group.position.copy(position)
        figure.group.userData.personId = state.personId
        this.scene.add(figure.group)
        entry = { figure, state, position, path: null, pathIndex: 0, walkPhase: 0, moving: false, pose: null, posePhase: 0 }
        this.residents.set(state.personId, entry)
      }
      const destinationChanged = isNew || JSON.stringify(entry.state.destination ?? null) !== JSON.stringify(state.destination ?? null)
      const activityChanged = isNew || entry.state.activity !== state.activity || entry.state.at !== state.at
      entry.state = state
      if (destinationChanged) {
        const atDestination = state.destination
          && Math.abs(entry.position.x - (state.destination.x + 0.5)) < 0.01
          && Math.abs(entry.position.z - (state.destination.z + 0.5)) < 0.01
        if (state.destination && !atDestination) {
          const from = { x: Math.floor(entry.position.x), y: Math.floor(entry.position.y), z: Math.floor(entry.position.z) }
          entry.path = findPath(this.world, this.registry, from, state.destination)
          entry.pathIndex = 0
          entry.moving = !!entry.path && entry.path.length > 0
        } else {
          entry.path = null
          entry.moving = false
        }
      }
      if (entry.moving) entry.pose = null
      else if (activityChanged || destinationChanged) this.resolvePose(entry)
    }
    for (const [personId, entry] of this.residents) {
      if (!seen.has(personId)) {
        this.scene.remove(entry.figure.group)
        this.residents.delete(personId)
      }
    }
    // 交谈是双边的:配对依据(谁在附近)每次同步都重算
    this.resolveTalkPairs()
  }

  /**
   * V1 姿态裁决:只有活动标签意图 + 真实依据(活动点对象/谈话对象)同时成立才摆姿态;
   * 缺依据保持默认站立(pose=null),不虚构。
   */
  private resolvePose(entry: ResidentEntry): void {
    entry.pose = null
    const intent = activityIntent(entry.state.activity)
    if (!intent || intent === 'talk') return // talk 由 resolveTalkPairs 双边裁决
    const anchors = findActivityAnchors(this.world.doc, this.registry)
    const kind = intent === 'sit' ? 'seat' : 'reading'
    let best: ActivityAnchor | null = null
    let bestDist = Infinity
    for (const anchor of anchors) {
      if (anchor.kind !== kind) continue
      const dist = Math.hypot(anchor.cell.x + 0.5 - entry.position.x, anchor.cell.z + 0.5 - entry.position.z)
      if (dist < bestDist) { best = anchor; bestDist = dist }
    }
    if (!best || bestDist > POSE_BASIS_RADIUS) return // 无对象依据,不虚构
    entry.pose = intent === 'sit'
      ? { kind: 'sit', basis: best.objectId, cell: best.cell, facing: best.facing }
      : { kind: 'read', basis: best.objectId, cell: best.cell, facing: best.facing }
  }

  /** 交谈姿态:两名停驻居民距离 ≤POSE_BASIS_RADIUS 且双方活动都含交谈意图时,互相面对 */
  private resolveTalkPairs(): void {
    const stationary = [...this.residents.values()].filter((e) => !e.moving)
    const talkers = stationary.filter((e) => activityIntent(e.state.activity) === 'talk')
    const paired = new Set<string>()
    for (const entry of talkers) {
      let partner: ResidentEntry | null = null
      let bestDist = Infinity
      for (const other of talkers) {
        if (other === entry) continue
        const dist = entry.position.distanceTo(other.position)
        if (dist < bestDist) { partner = other; bestDist = dist }
      }
      if (partner && bestDist <= POSE_BASIS_RADIUS) {
        entry.pose = { kind: 'talk', basis: partner.state.personId }
        paired.add(entry.state.personId)
      } else if (entry.pose?.kind === 'talk') {
        entry.pose = null // 谈话对象离开,回到默认站立
      }
    }
    // 非交谈意图居民的 talk 姿态清理由 resolvePose/状态更新负责
    void paired
  }

  update(dt: number): void {
    for (const entry of this.residents.values()) {
      if (entry.moving && entry.path) {
        entry.pose = null
        const targetCell = entry.path[entry.pathIndex]
        const target = new THREE.Vector3(targetCell.x + 0.5, targetCell.y, targetCell.z + 0.5)
        const delta = target.clone().sub(entry.position)
        const dist = delta.length()
        const step = WALK_SPEED * dt
        if (dist <= step) {
          entry.position.copy(target)
          entry.pathIndex += 1
          if (entry.pathIndex >= entry.path.length) {
            entry.moving = false
            entry.path = null
            this.resolvePose(entry) // 到位后按依据恢复姿态
          }
        } else {
          entry.position.addScaledVector(delta.normalize(), step)
        }
        entry.figure.group.position.copy(entry.position)
        entry.figure.group.rotation.y = Math.atan2(delta.x, delta.z)
        entry.walkPhase += dt * 9
        const swing = Math.sin(entry.walkPhase) * 0.55
        entry.figure.leftLeg.rotation.x = swing
        entry.figure.rightLeg.rotation.x = -swing
        entry.figure.leftArm.rotation.x = -swing * 0.8
        entry.figure.rightArm.rotation.x = swing * 0.8
      } else {
        this.updatePose(entry, dt)
      }
    }
  }

  /** 停驻时的姿态表现;无姿态则四肢归位 */
  private updatePose(entry: ResidentEntry, dt: number): void {
    const { figure } = entry
    const pose = entry.pose
    if (!pose) {
      for (const limb of [figure.leftLeg, figure.rightLeg, figure.leftArm, figure.rightArm]) {
        limb.rotation.x *= 0.8
      }
      return
    }
    entry.posePhase += dt
    if (pose.kind === 'sit') {
      // 坐下:髋部贴在面板顶面,双腿前伸(以髋为轴前旋 ~90°),面朝座位朝向
      const seatTop = pose.cell.y + 1
      entry.position.set(pose.cell.x + 0.5, seatTop - LEG_TOP + 0.02, pose.cell.z + 0.5)
      figure.group.position.copy(entry.position)
      figure.group.rotation.y = Math.atan2(pose.facing.x, pose.facing.z)
      figure.leftLeg.rotation.x = -Math.PI / 2 * 0.92
      figure.rightLeg.rotation.x = -Math.PI / 2 * 0.92
      figure.leftArm.rotation.x *= 0.8
      figure.rightArm.rotation.x *= 0.8
      return
    }
    if (pose.kind === 'read') {
      // 阅读:站在架前格、面朝书架,双臂前抬持书,轻微翻动起伏
      entry.position.set(pose.cell.x + 0.5, pose.cell.y, pose.cell.z + 0.5)
      figure.group.position.copy(entry.position)
      figure.group.rotation.y = Math.atan2(pose.facing.x, pose.facing.z)
      figure.leftLeg.rotation.x *= 0.8
      figure.rightLeg.rotation.x *= 0.8
      const hold = -1.15 + Math.sin(entry.posePhase * 1.6) * 0.05
      figure.leftArm.rotation.x = hold
      figure.rightArm.rotation.x = hold
      return
    }
    // 交谈:面向对方,单手小幅手势,另一手自然下垂
    const partner = this.residents.get(pose.basis)
    if (!partner) { entry.pose = null; return }
    const delta = partner.position.clone().sub(entry.position)
    figure.group.rotation.y = Math.atan2(delta.x, delta.z)
    figure.leftLeg.rotation.x *= 0.8
    figure.rightLeg.rotation.x *= 0.8
    figure.leftArm.rotation.x *= 0.8
    figure.rightArm.rotation.x = -0.5 + Math.sin(entry.posePhase * 2.2) * 0.35
  }

  /** 射线拾取：命中居民返回 personId */
  pick(raycaster: THREE.Raycaster): string | null {
    const groups = [...this.residents.values()].map((e) => e.figure.group)
    const hits = raycaster.intersectObjects(groups, true)
    for (const hit of hits) {
      let obj: THREE.Object3D | null = hit.object
      while (obj) {
        if (typeof obj.userData.personId === 'string') return obj.userData.personId
        obj = obj.parent
      }
    }
    return null
  }

  /** 当前快照（调试 / e2e 探针）;pose 含真实依据,无依据为 null */
  snapshot(): Array<{
    personId: string
    position: { x: number; y: number; z: number }
    moving: boolean
    pose: { kind: ResidentPose['kind']; basis: string } | null
  }> {
    return [...this.residents.values()].map((e) => ({
      personId: e.state.personId,
      position: { x: e.position.x, y: e.position.y, z: e.position.z },
      moving: e.moving,
      pose: e.pose ? { kind: e.pose.kind, basis: e.pose.basis } : null,
    }))
  }

  dispose(): void {
    for (const entry of this.residents.values()) this.scene.remove(entry.figure.group)
    this.residents.clear()
  }
}
