import type { BlockRegistry, VoxelCoord } from '@possibility/voxel-contract'
import type { WorldModel } from './world-model'

// ── S2b 第一视角玩家物理(F2/F3)─────────────────────────
// 纯逻辑:不依赖 THREE 渲染对象,单测可直接驱动。
// 碰撞箱 = 以 position(脚底中心)为基准 ±width/2、高 height 的 AABB;
// 轴分离解算:先 y 后 xz,水平受阻时尝试 ≤stepHeight 的自动上台阶。

export const PLAYER = {
  width: 0.6,
  height: 1.8,
  eye: 1.62,
  walkSpeed: 4.3,
  flySpeed: 10,
  jumpSpeed: 8.5,
  gravity: 28,
  terminal: 50,
  stepHeight: 1.01,
} as const

export interface PlayerState {
  position: { x: number; y: number; z: number }   // 脚底中心(浮点,世界坐标)
  velocity: { x: number; y: number; z: number }
  onGround: boolean
  flying: boolean
}

export interface MoveInput {
  moveX: number      // 世界坐标水平移动分量(-1..1,调用方已按相机朝向换算)
  moveZ: number
  jump: boolean      // 行走时跳跃
  ascend: boolean    // 飞行时上升(空格)
  descend: boolean   // 飞行时下降(Shift)
}

const IDLE: MoveInput = { moveX: 0, moveZ: 0, jump: false, ascend: false, descend: false }

export class PlayerBody {
  readonly state: PlayerState
  readonly spawnPoint: VoxelCoord
  /** 最近一次确认有实体支撑的脚底位置，跌出悬空区域时回到这里。 */
  private recoveryPosition: { x: number; y: number; z: number }

  constructor(
    private world: WorldModel,
    private registry: BlockRegistry,
    spawn: VoxelCoord,
  ) {
    this.spawnPoint = { ...spawn }
    // spawn 为可站立整数格;脚底 = 格中心
    this.state = {
      position: { x: spawn.x + 0.5, y: spawn.y, z: spawn.z + 0.5 },
      velocity: { x: 0, y: 0, z: 0 },
      onGround: false,
      flying: false,
    }
    this.recoveryPosition = { ...this.state.position }
  }

  /** 安全复位：跌落虚空时安全返回出生点 */
  respawnToSafe(): void {
    this.state.position = { x: this.spawnPoint.x + 0.5, y: this.spawnPoint.y, z: this.spawnPoint.z + 0.5 }
    this.state.velocity = { x: 0, y: 0, z: 0 }
    this.state.onGround = true
  }

  setFlying(flying: boolean): void {
    this.state.flying = flying
    this.state.velocity.y = 0
  }

  /** 一个逻辑步。调用方保证 dt ≤ 1/30(单步位移 < 0.5 格,N2 不穿墙) */
  step(dt: number, input: MoveInput = IDLE): void {
    const s = this.state
    const speed = s.flying ? PLAYER.flySpeed : PLAYER.walkSpeed
    const len = Math.hypot(input.moveX, input.moveZ)
    const scale = len > 1 ? 1 / len : 1
    s.velocity.x = input.moveX * scale * speed
    s.velocity.z = input.moveZ * scale * speed

    if (s.flying) {
      s.velocity.y = (input.ascend ? speed : 0) + (input.descend ? -speed : 0)
    } else {
      s.velocity.y = Math.max(s.velocity.y - PLAYER.gravity * dt, -PLAYER.terminal)
      if (input.jump && s.onGround) {
        s.velocity.y = PLAYER.jumpSpeed
        s.onGround = false
      }
    }

    this.moveAxis('y', s.velocity.y * dt)
    this.moveAxis('x', s.velocity.x * dt)
    this.moveAxis('z', s.velocity.z * dt)
    this.clampToWorld()
    if (s.onGround && s.position.y >= 1 && this.hasSupport(s.position.x, s.position.y, s.position.z)) {
      this.recoveryPosition = { ...s.position }
    }
  }

  /** 该格是否阻挡玩家(实心且非流体) */
  private isBlocking(at: VoxelCoord): boolean {
    const b = this.registry.get(this.world.getBlock(at))
    return !!b?.solid && b.category !== 'fluid'
  }

  /** 脚底下存在可碰撞方块；世界底边以下视为虚空而不是地面。 */
  private hasSupport(px: number, py: number, pz: number): boolean {
    const y = Math.floor(py) - 1
    if (y < 0) return false
    return this.isBlocking({ x: Math.floor(px), y, z: Math.floor(pz) })
  }

  /** 将玩家恢复到最近合法落脚点，避免在无地面世界永久停在 y=0。 */
  private recoverFromFall(): void {
    const p = this.state.position
    p.x = this.recoveryPosition.x
    p.y = this.recoveryPosition.y
    p.z = this.recoveryPosition.z
    this.state.velocity.x = 0
    this.state.velocity.y = 0
    this.state.velocity.z = 0
    this.state.onGround = true
  }

  /** 碰撞箱当前覆盖的整数格是否与实心方块相交 */
  private collides(px: number, py: number, pz: number): boolean {
    const half = PLAYER.width / 2
    const x0 = Math.floor(px - half), x1 = Math.floor(px + half - 1e-9)
    const y0 = Math.floor(py), y1 = Math.floor(py + PLAYER.height - 1e-9)
    const z0 = Math.floor(pz - half), z1 = Math.floor(pz + half - 1e-9)
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++)
          if (this.isBlocking({ x, y, z })) return true
    return false
  }

  /** 沿单轴移动,碰撞则回退;水平受阻时尝试自动上台阶(T9) */
  private moveAxis(axis: 'x' | 'y' | 'z', delta: number): void {
    if (delta === 0) {
      if (axis === 'y') this.state.onGround = false
      return
    }
    const p = this.state.position
    const next = { ...p, [axis]: p[axis] + delta }
    if (!this.collides(next.x, next.y, next.z)) {
      p[axis] = next[axis]
      if (axis === 'y') this.state.onGround = false
      return
    }
    // 二分逼近接触面,避免回退过量
    let lo = 0, hi = delta
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) / 2
      const probe = { ...p, [axis]: p[axis] + mid }
      if (this.collides(probe.x, probe.y, probe.z)) hi = mid
      else lo = mid
    }
    p[axis] += lo
    if (axis === 'y') {
      if (delta < 0) this.state.onGround = true
      this.state.velocity.y = 0
      return
    }
    // 自动上台阶(F2):水平受阻且抬升 ≤stepHeight 后可通过 → 抬脚走过去
    if (!this.state.flying) this.tryStepUp(axis, delta)
  }

  /** 水平受阻时尝试台阶辅助:抬升到整数踏面(≤stepHeight)后重试该轴位移 */
  private tryStepUp(axis: 'x' | 'z', delta: number): void {
    const p = this.state.position
    const maxFoot = p.y + PLAYER.stepHeight
    for (let foot = Math.ceil(p.y + 1e-6); foot <= maxFoot + 1e-6; foot++) {
      if (this.collides(p.x, foot, p.z)) continue          // 抬升位置被挡(头顶)
      const nx = axis === 'x' ? p.x + delta : p.x
      const nz = axis === 'z' ? p.z + delta : p.z
      if (this.collides(nx, foot, nz)) continue            // 抬上去仍然撞
      p.y = foot
      p[axis] += delta
      this.state.onGround = true
      return
    }
  }

  /** 世界包围盒钳制:不出界、不穿基岩层;跌落无底虚空时安全复位 */
  private clampToWorld(): void {
    const { width, depth } = this.world.doc.size
    const p = this.state.position
    const half = PLAYER.width / 2
    p.x = Math.min(Math.max(p.x, half), width - half)
    p.z = Math.min(Math.max(p.z, half), depth - half)
    // A fall through a hole must recover to a known grounded location. Merely
    // clamping to y=0 leaves the player permanently suspended in void cells.
    if (p.y < 1 && !this.hasSupport(p.x, p.y, p.z)) {
      this.recoverFromFall()
      return
    }
    if (p.y < 0) {
      const bx = Math.floor(p.x)
      const bz = Math.floor(p.z)
      const floorBlock = this.world.getBlock({ x: bx, y: 0, z: bz })
      const isSolidFloor = this.registry.get(floorBlock)?.solid
      if (isSolidFloor) {
        p.y = 0
        this.state.velocity.y = Math.max(0, this.state.velocity.y)
        this.state.onGround = true
      } else {
        // 跌落无方块支撑的虚空：安全复位到出生点
        this.respawnToSafe()
      }
    }
  }
}
