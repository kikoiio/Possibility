import * as THREE from 'three'
import type { BlockRegistry } from '@possibility/voxel-contract'

// ── 帧表与 UV ─────────────────────────────────
export interface AtlasFrame { x: number; y: number; w: number; h: number }
export interface UVRect { u0: number; v0: number; u1: number; v1: number }
export interface AtlasJson { width: number; height: number; frames: Record<string, AtlasFrame> }

/** 帧名 → UV 矩形（纯函数，供单测） */
export function computeUV(frame: AtlasFrame, atlasWidth: number, atlasHeight: number): UVRect {
  // 半像素内缩，避免相邻帧渗色
  const inset = 0.5
  return {
    u0: (frame.x + inset) / atlasWidth,
    v0: 1 - (frame.y + frame.h - inset) / atlasHeight,
    u1: (frame.x + frame.w - inset) / atlasWidth,
    v1: 1 - (frame.y + inset) / atlasHeight,
  }
}

export class TextureAtlas {
  texture: THREE.Texture | null = null
  private uvRects = new Map<string, UVRect>()

  /** 加载主题图集（PNG + JSON 帧表） */
  async load(theme: string, baseUrl = '/voxel-assets'): Promise<void> {
    const [json, image] = await Promise.all([
      fetch(`${baseUrl}/${theme}/atlas.json`).then((r) => {
        if (!r.ok) throw new Error(`atlas json for theme '${theme}' not found (${r.status})`)
        return r.json() as Promise<AtlasJson>
      }),
      new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image()
        img.onload = () => resolve(img)
        img.onerror = () => reject(new Error(`atlas png for theme '${theme}' failed to load`))
        img.src = `${baseUrl}/${theme}/atlas.png`
      }),
    ])
    this.setTexture(new THREE.Texture(image), json)
  }

  /** 注入外部构建好的图集数据（占位图集 / 测试） */
  setTexture(texture: THREE.Texture, json: AtlasJson): void {
    texture.colorSpace = THREE.SRGBColorSpace
    texture.magFilter = THREE.NearestFilter
    texture.minFilter = THREE.NearestFilter
    texture.generateMipmaps = false
    texture.needsUpdate = true
    this.texture = texture
    this.uvRects.clear()
    for (const [name, frame] of Object.entries(json.frames)) {
      this.uvRects.set(name, computeUV(frame, json.width, json.height))
    }
  }

  uv(frameName: string): UVRect {
    const rect = this.uvRects.get(frameName)
    if (!rect) throw new Error(`atlas frame missing: '${frameName}'`)
    return rect
  }

  has(frameName: string): boolean {
    return this.uvRects.has(frameName)
  }

  frameNames(): string[] {
    return [...this.uvRects.keys()]
  }
}

// ── 程序化占位图集（开发期使用，纯色 + 边框）─────
const PLACEHOLDER_TILE = 32

function hashColor(name: string): string {
  let h = 2166136261
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  const r = 80 + (h & 0x7f), g = 80 + ((h >> 8) & 0x7f), b = 80 + ((h >> 16) & 0x7f)
  return `rgb(${r},${g},${b})`
}

/** 注册表 → 占位图集（每个纹理帧一格纯色块 + 深色描边） */
export function buildPlaceholderAtlas(registry: BlockRegistry): { canvas: HTMLCanvasElement; json: AtlasJson } {
  const names = new Set<string>()
  for (const block of registry.list()) {
    names.add(block.textures.top)
    names.add(block.textures.side)
    if (block.textures.bottom) names.add(block.textures.bottom)
  }
  const list = [...names].sort()
  const cols = Math.ceil(Math.sqrt(list.length))
  const rows = Math.ceil(list.length / cols)
  const canvas = document.createElement('canvas')
  canvas.width = cols * PLACEHOLDER_TILE
  canvas.height = rows * PLACEHOLDER_TILE
  const ctx = canvas.getContext('2d')!
  const frames: Record<string, AtlasFrame> = {}
  list.forEach((name, i) => {
    const x = (i % cols) * PLACEHOLDER_TILE
    const y = Math.floor(i / cols) * PLACEHOLDER_TILE
    ctx.fillStyle = hashColor(name)
    ctx.fillRect(x, y, PLACEHOLDER_TILE, PLACEHOLDER_TILE)
    ctx.strokeStyle = 'rgba(0,0,0,0.45)'
    ctx.lineWidth = 2
    ctx.strokeRect(x + 1, y + 1, PLACEHOLDER_TILE - 2, PLACEHOLDER_TILE - 2)
    ctx.fillStyle = 'rgba(255,255,255,0.25)'
    ctx.fillRect(x + 3, y + 3, PLACEHOLDER_TILE - 6, 3)
    frames[name] = { x, y, w: PLACEHOLDER_TILE, h: PLACEHOLDER_TILE }
  })
  return { canvas, json: { width: canvas.width, height: canvas.height, frames } }
}
