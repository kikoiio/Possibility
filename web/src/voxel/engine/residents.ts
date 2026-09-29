import * as THREE from 'three'
import type { BlockRegistry, VoxelCoord } from '@possibility/voxel-contract'
import { findPath, nearestStandable } from './pathfinding'
import type { WorldModel } from './world-model'

export interface ResidentRenderState {
  personId: string
  name?: string
  /** 当前所在格（首次同步时的放置点） */
  at: VoxelCoord
  /** 目的地；与当前位置不同则寻路行走，到达后停驻 */
  destination?: VoxelCoord | null
  /** 活动标签（产品层展示用，引擎只透传） */
  activity?: string
  colorHint?: number
}

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

/** 方块小人：盒体拼装，程序化摆臂/迈步（O8：不做骨骼系统） */
function buildFigure(color: number): { group: THREE.Group; leftArm: THREE.Mesh; rightArm: THREE.Mesh; leftLeg: THREE.Mesh; rightLeg: THREE.Mesh } {
  const group = new THREE.Group()
  const darker = new THREE.Color(color).multiplyScalar(0.72).getHex()
  const skin = 0xe8c39a
  const body = box(0.5, 0.62, 0.28, color, 0, 0.86, 0)
  const head = box(0.36, 0.34, 0.32, skin, 0, 1.36, 0)
  const leftArm = box(0.13, 0.5, 0.13, darker, -0.33, 1.0, 0)
  const rightArm = box(0.13, 0.5, 0.13, darker, 0.33, 1.0, 0)
  const leftLeg = box(0.16, 0.55, 0.16, 0x3a3f4a, -0.13, 0.28, 0)
  const rightLeg = box(0.16, 0.55, 0.16, 0x3a3f4a, 0.13, 0.28, 0)
  // 四肢以顶端为旋转轴心
  for (const [limb, topY] of [[leftArm, 1.25], [rightArm, 1.25], [leftLeg, 0.55], [rightLeg, 0.55]] as const) {
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
        entry = { figure, state, position, path: null, pathIndex: 0, walkPhase: 0, moving: false }
        this.residents.set(state.personId, entry)
      }
      const destinationChanged = isNew || JSON.stringify(entry.state.destination ?? null) !== JSON.stringify(state.destination ?? null)
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
    }
    for (const [personId, entry] of this.residents) {
      if (!seen.has(personId)) {
        this.scene.remove(entry.figure.group)
        this.residents.delete(personId)
      }
    }
  }

  update(dt: number): void {
    for (const entry of this.residents.values()) {
      if (entry.moving && entry.path) {
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
        // 停驻：四肢归位
        for (const limb of [entry.figure.leftLeg, entry.figure.rightLeg, entry.figure.leftArm, entry.figure.rightArm]) {
          limb.rotation.x *= 0.8
        }
      }
    }
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

  /** 当前快照（调试 / e2e 探针） */
  snapshot(): Array<{ personId: string; position: { x: number; y: number; z: number }; moving: boolean }> {
    return [...this.residents.values()].map((e) => ({
      personId: e.state.personId,
      position: { x: e.position.x, y: e.position.y, z: e.position.z },
      moving: e.moving,
    }))
  }

  dispose(): void {
    for (const entry of this.residents.values()) this.scene.remove(entry.figure.group)
    this.residents.clear()
  }
}
