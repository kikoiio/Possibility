import { Assets, Rectangle, Texture } from 'pixi.js'
import type { SceneThemeManifest } from '@possibility/scene-contract'

export interface AtlasFrame { frame: { x: number; y: number; w: number; h: number } }
export interface AtlasData { frames: Record<string, AtlasFrame>; meta: { image: string; size: { w: number; h: number } } }
export class AssetLoader {
  private readonly textures = new Map<string, Texture>()
  private readonly sources = new Set<string>()
  async load(theme: SceneThemeManifest): Promise<void> {
    for (const sheet of theme.sheets) {
      const jsonUrl = sheet.src.replace(/\.png$/, '.json')
      const response = await fetch(jsonUrl)
      if (!response.ok) throw new Error(`无法读取图集元数据：${sheet.id}`)
      const atlas = await response.json() as AtlasData
      const base = await Assets.load<Texture>(sheet.src)
      this.sources.add(sheet.src)
      const frameNames = new Set(theme.assets.filter(asset => asset.sprite.sheetId === sheet.id).flatMap(asset => [asset.sprite.frame, ...Object.values(asset.sprite.states ?? {})]))
      for (const name of frameNames) {
        const frame = atlas.frames[name]?.frame
        if (!frame) throw new Error(`图集 ${sheet.id} 缺少帧 ${name}`)
        if (frame.x < 0 || frame.y < 0 || frame.x + frame.w > atlas.meta.size.w || frame.y + frame.h > atlas.meta.size.h) throw new Error(`图集帧越界：${name}`)
        this.textures.set(name, new Texture({ source: base.source, frame: new Rectangle(frame.x, frame.y, frame.w, frame.h) }))
      }
    }
  }
  texture(frame: string): Texture | undefined { return this.textures.get(frame) }
  dispose(): void { for (const texture of this.textures.values()) texture.destroy(false); this.textures.clear(); this.sources.clear() }
}
