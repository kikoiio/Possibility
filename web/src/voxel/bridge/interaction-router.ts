import * as THREE from 'three'
import { Picker, type VoxelEngine } from '../engine'

export interface InteractionHandlers {
  /** 点击居民 → 查看其活动（F20） */
  onPerson?(personId: string): void
  /** 点击绑定地点的物体 → 查看地点 */
  onLocation?(objectId: string, locationName: string): void
  /** 点击绑定人物的物体 */
  onObjectPerson?(objectId: string, personId: string): void
  /** 点击普通物体（编辑器选中） */
  onObject?(objectId: string): void
  /** 点击空间入口 → shell 导航（F19） */
  onEnterSpace?(spaceId: string): void
}

/**
 * 拾取事件 → 产品交互：居民活动、地点详情、多空间导航。
 * 返回 true 表示命中并消费了这次点击。
 */
export class InteractionRouter {
  constructor(private engine: VoxelEngine, private handlers: InteractionHandlers) {}

  handleClick(clientX: number, clientY: number): boolean {
    const canvas = this.engine.renderer.canvas
    const doc = this.engine.world?.doc
    if (!canvas || !doc || !this.engine.picker || !this.engine.residents) return false
    const ray = Picker.rayFromScreen(clientX, clientY, canvas, this.engine.cameraRig.camera)

    // 1. 居民优先（角色在体素网格之上）
    const raycaster = new THREE.Raycaster(ray.origin, ray.direction)
    const personId = this.engine.residents.pick(raycaster)
    if (personId) {
      this.handlers.onPerson?.(personId)
      return true
    }

    const hit = this.engine.picker.pickVoxel(ray)
    if (!hit) return false

    // 2. 空间入口（命中格紧邻入口触发点）
    for (const entry of doc.spaceEntries) {
      if (Math.abs(entry.at.x - hit.at.x) <= 1 && Math.abs(entry.at.z - hit.at.z) <= 1 && Math.abs(entry.at.y - hit.at.y) <= 2) {
        this.handlers.onEnterSpace?.(entry.spaceId)
        return true
      }
    }

    // 3. 物体 → 地点 / 人物 / 普通（地点绑定先看物体自带，再查文档 locations 表）
    const objectId = this.engine.picker.pickObject(ray)
    if (!objectId) return false
    const object = doc.objects.find((o) => o.id === objectId)
    const locationName = object?.binding?.kind === 'location'
      ? object.binding.locationName
      : doc.locations.find((l) => l.objectId === objectId)?.name
    if (locationName) {
      this.handlers.onLocation?.(objectId, locationName)
    } else if (object?.binding?.kind === 'person') {
      this.handlers.onObjectPerson?.(objectId, object.binding.personId)
    } else {
      this.handlers.onObject?.(objectId)
    }
    return true
  }
}
