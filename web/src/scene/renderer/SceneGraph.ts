import { Container, Graphics, Sprite } from 'pixi.js'
import { gridToScreen } from '@possibility/scene-contract'
import type { SceneDocument, SceneLifeOverlay, ScenePreviewResult, SceneThemeManifest } from '@possibility/scene-contract'
import { AssetLoader } from './AssetLoader'

export interface SceneLayers { ground: Container; paths: Container; objects: Container; people: Container; weather: Container; preview: Container }
export function createSceneLayers(stage: Container): SceneLayers {
  const layers = { ground: new Container(), paths: new Container(), objects: new Container(), people: new Container(), weather: new Container(), preview: new Container() }
  Object.values(layers).forEach(layer => { layer.sortableChildren = true; stage.addChild(layer) })
  return layers
}
function point(x: number, y: number, size: { columns: number; rows: number }, tile = { width: 64, height: 32 }) {
  const center = gridToScreen({ x: size.columns / 2, y: size.rows / 2 }, tile)
  const p = gridToScreen({ x, y }, tile)
  return { x: p.x - center.x, y: p.y - center.y }
}
export function renderScene(layers: SceneLayers, loader: AssetLoader, scene: SceneDocument, theme: SceneThemeManifest, overlay: SceneLifeOverlay | null = null, preview: ScenePreviewResult | null = null, selectedId: string | null = null) {
  Object.values(layers).forEach(layer => (layer.removeChildren() as Container[]).forEach(child => child.destroy({ children: true })))
  const assetById = new Map(theme.assets.map(asset => [asset.id, asset]))
  const terrainByCell = new Map(scene.terrain.map(tile => [`${tile.x},${tile.y}`, tile]))
  const defaultGround = assetById.get('terrain-grass')
  for (let y = 0; y < scene.size.rows; y++) for (let x = 0; x < scene.size.columns; x++) {
    const tile = terrainByCell.get(`${x},${y}`) ?? (defaultGround ? { x, y, assetId: defaultGround.id } : undefined)
    const asset = tile && assetById.get(tile.assetId); const texture = asset && loader.texture(asset.sprite.frame); if (!asset || !texture) continue
    const p = point(tile.x, tile.y, scene.size); const sprite = new Sprite(texture)
    sprite.anchor.set(asset.anchor.x, asset.anchor.y); sprite.width = 64; sprite.height = 32; sprite.position.set(p.x, p.y); sprite.zIndex = tile.x + tile.y; layers.ground.addChild(sprite)
  }
  for (const path of scene.paths) for (const cell of path.cells) {
    const asset = assetById.get(path.assetId); const texture = asset && loader.texture(asset.sprite.frame); if (!asset || !texture) continue
    const p = point(cell.x, cell.y, scene.size); const sprite = new Sprite(texture); sprite.anchor.set(.5, 1); sprite.width = 64; sprite.height = 32; sprite.position.set(p.x, p.y); sprite.zIndex = cell.x + cell.y; layers.paths.addChild(sprite)
  }
  const locations = new Map<string, SceneDocument['objects'][number]>()
  for (const object of scene.objects) {
    const asset = assetById.get(object.assetId); const texture = asset && loader.texture(asset.sprite.frame); if (!asset || !texture) continue
    if (overlay && object.binding?.kind === 'person') continue
    const p = point(object.position.x, object.position.y, scene.size); const sprite = new Sprite(texture); sprite.anchor.set(asset.anchor.x, asset.anchor.y)
    sprite.width = Math.max(64, asset.footprint.width * 64); sprite.height = Math.max(32, asset.footprint.height * 32); sprite.position.set(p.x, p.y + asset.sortOffset); sprite.zIndex = (object.position.x + object.position.y) * 100 + asset.sortOffset
    sprite.label = object.id; sprite.eventMode = 'static'; sprite.cursor = 'pointer'; (sprite as Sprite & { objectId: string }).objectId = object.id; layers.objects.addChild(sprite)
    if (object.binding?.kind === 'location') locations.set(object.binding.locationName, object)
    if (selectedId === object.id) {
      const outline = new Graphics().roundRect(p.x - 24, p.y - sprite.height - 10, sprite.width + 16, sprite.height + 18, 10).stroke({ color: 0xffffff, width: 4 })
      outline.zIndex = sprite.zIndex - 1; layers.preview.addChild(outline)
    }
    if (scene.lockedObjectIds.includes(object.id)) {
      const lock = new Graphics().roundRect(p.x + sprite.width / 2 - 7, p.y - sprite.height - 8, 16, 15, 3).fill({ color: 0x435649 }).roundRect(p.x + sprite.width / 2 - 4, p.y - sprite.height - 14, 10, 10, 5).stroke({ color: 0x435649, width: 3 })
      lock.zIndex = sprite.zIndex + 2; layers.preview.addChild(lock)
    }
  }
  if (overlay) for (const person of overlay.persons) {
    const building = locations.get(person.locationName); if (!building) continue
    const avatar = scene.objects.find(o => o.binding?.kind === 'person' && o.binding.personId === person.personId); const asset = avatar && assetById.get(avatar.assetId); if (!asset) continue
    const frame = asset.sprite.states?.idle ?? asset.sprite.frame; const texture = loader.texture(frame); if (!texture) continue
    const p = point(building.position.x + 1, building.position.y + 1, scene.size); const sprite = new Sprite(texture); sprite.anchor.set(.5, 1); sprite.width = 36; sprite.height = 48; sprite.position.set(p.x, p.y); sprite.zIndex = (building.position.x + building.position.y) * 100 + 50; layers.people.addChild(sprite)
  }
  if (overlay?.timeOfDay === 'night') layers.weather.addChild(new Graphics().rect(-scene.size.columns * 32, -scene.size.rows * 16, scene.size.columns * 64, scene.size.rows * 32).fill({ color: 0x1e3150, alpha: .27 }))
  if (overlay?.timeOfDay === 'night') for (const object of scene.objects) {
    const asset = assetById.get(object.assetId); if (asset?.category !== 'building') continue
    const p = point(object.position.x, object.position.y, scene.size)
    layers.weather.addChild(new Graphics().circle(p.x + asset.footprint.width * 28, p.y - asset.footprint.height * 22, 5).fill({ color: 0xffd98a, alpha: .82 }))
  }
  if (overlay?.weather?.toLowerCase().includes('rain')) layers.weather.addChild(new Graphics().rect(-scene.size.columns * 32, -scene.size.rows * 16, scene.size.columns * 64, scene.size.rows * 32).fill({ color: 0x8098ad, alpha: .15 }))
  if (preview) for (const id of [...preview.changes.added, ...preview.changes.moved, ...preview.changes.updated, ...preview.changes.removed]) {
    const object = preview.document.objects.find(o => o.id === id) ?? scene.objects.find(o => o.id === id); if (!object) continue
    const asset = assetById.get(object.assetId); if (!asset) continue
    const p = point(object.position.x, object.position.y, scene.size); const marker = new Graphics().roundRect(p.x - 18, p.y - 40, Math.max(38, asset.footprint.width * 60), Math.max(40, asset.footprint.height * 30), 8).stroke({ color: preview.changes.removed.includes(id) ? 0xc14f4f : 0x287a61, width: 3, alpha: .85 })
    marker.zIndex = (object.position.x + object.position.y) * 100 + 99; layers.preview.addChild(marker)
  }
  return { assetById }
}
