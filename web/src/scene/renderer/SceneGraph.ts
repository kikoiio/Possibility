import { Container, Graphics, Sprite, Text } from 'pixi.js'
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
function objectGroundPoint(object: SceneDocument['objects'][number], footprint: { width: number; height: number }, size: SceneDocument['size']) {
  return point(object.position.x + (footprint.width - 1) / 2, object.position.y + (footprint.height - 1) / 2, size)
}
export function renderScene(layers: SceneLayers, loader: AssetLoader, scene: SceneDocument, theme: SceneThemeManifest, overlay: SceneLifeOverlay | null = null, preview: ScenePreviewResult | null = null, selectedId: string | null = null) {
  Object.values(layers).forEach(layer => (layer.removeChildren() as Container[]).forEach(child => child.destroy({ children: true })))
  const assetById = new Map(theme.assets.map(asset => [asset.id, asset]))
  const terrainByCell = new Map(scene.terrain.map(tile => [`${tile.x},${tile.y}`, tile]))
  const defaultGround = assetById.get('terrain-grass')
  if (theme.id === 'mist-manor') {
    const corners = [point(-.5, -.5, scene.size), point(scene.size.columns - .5, -.5, scene.size), point(scene.size.columns - .5, scene.size.rows - .5, scene.size), point(-.5, scene.size.rows - .5, scene.size)]
    const interior = scene.terrain[0]?.assetId === 'mist-stone'
    const ground = new Graphics().poly(corners.flatMap(corner => [corner.x, corner.y])).fill({ color: interior ? 0x72695d : 0x536b43, alpha: 1 }).stroke({ color: interior ? 0x3f3a34 : 0x30442f, width: 3, alpha: .8 })
    ground.zIndex = -1000
    layers.ground.addChild(ground)
  }
  for (let y = 0; theme.id !== 'mist-manor' && y < scene.size.rows; y++) for (let x = 0; x < scene.size.columns; x++) {
    const tile = terrainByCell.get(`${x},${y}`) ?? (defaultGround ? { x, y, assetId: defaultGround.id } : undefined)
    const asset = tile && assetById.get(tile.assetId); const texture = asset && loader.texture(asset.sprite.frame); if (!asset || !texture) continue
    const p = point(tile.x, tile.y, scene.size); const sprite = new Sprite(texture)
    sprite.anchor.set(asset.anchor.x, asset.anchor.y); sprite.width = 64; sprite.height = 32; sprite.position.set(p.x, p.y); sprite.zIndex = tile.x + tile.y; layers.ground.addChild(sprite)
  }
  for (const path of scene.paths) for (const cell of path.cells) {
    const asset = assetById.get(path.assetId); const texture = asset && loader.texture(asset.sprite.frame); if (!asset || !texture) continue
    const p = point(cell.x, cell.y, scene.size); const sprite = new Sprite(texture); sprite.anchor.set(.5, 1); sprite.width = 64; sprite.height = 32; sprite.position.set(p.x, p.y); sprite.zIndex = cell.x + cell.y; layers.paths.addChild(sprite)
    if (path.category === 'water') {
      const shimmer = new Graphics().ellipse(p.x, p.y - 13, 9, 2).fill({ color: 0xe6fff7, alpha: .28 })
      shimmer.zIndex = sprite.zIndex + 1
      ;(shimmer as Graphics & { waterShimmer?: boolean }).waterShimmer = true
      layers.paths.addChild(shimmer)
    }
  }
  const locations = new Map<string, SceneDocument['objects'][number]>()
  for (const object of scene.objects) {
    const asset = assetById.get(object.assetId); if (!asset) continue
    if (asset.id.startsWith('manor-room-')) {
      const p = objectGroundPoint(object, asset.footprint, scene.size)
      const width = asset.footprint.width * 64; const depth = asset.footprint.height * 32; const wall = 74
      const room = new Graphics()
        .poly([p.x, p.y - depth / 2, p.x + width / 2, p.y, p.x, p.y + depth / 2, p.x - width / 2, p.y]).fill({ color: 0xb6a98f })
        .poly([p.x - width / 2, p.y, p.x, p.y - depth / 2, p.x, p.y - depth / 2 - wall, p.x - width / 2, p.y - wall]).fill({ color: 0x4a3b31 })
        .poly([p.x, p.y - depth / 2, p.x + width / 2, p.y, p.x + width / 2, p.y - wall, p.x, p.y - depth / 2 - wall]).fill({ color: 0x655045 })
        .poly([p.x, p.y - depth / 2, p.x + width / 2, p.y, p.x, p.y + depth / 2, p.x - width / 2, p.y]).stroke({ color: 0x302822, width: 3 })
      if (asset.id === 'manor-room-dining') room.roundRect(p.x - 58, p.y - 10, 116, 34, 4).fill({ color: 0x5b3928 }).circle(p.x - 75, p.y + 4, 10).circle(p.x + 75, p.y + 4, 10).fill({ color: 0x744a32 })
      else if (asset.id === 'manor-room-library') room.rect(p.x - width * .34, p.y - depth / 2 - wall + 12, width * .68, 30).fill({ color: 0x2f251f }).rect(p.x - width * .30, p.y - depth / 2 - wall + 17, width * .6, 3).fill({ color: 0xc39a56 })
      else if (asset.id === 'manor-room-study') room.roundRect(p.x - 44, p.y - 14, 88, 38, 4).fill({ color: 0x4c3023 }).circle(p.x + 6, p.y - 3, 8).fill({ color: 0xd9b66f })
      else room.poly([p.x - 70, p.y - 24, p.x - 10, p.y - 54, p.x + 45, p.y - 25, p.x - 15, p.y + 5]).fill({ color: 0x76563c }).circle(p.x + 58, p.y - 30, 10).fill({ color: 0xf1c878 })
      room.zIndex = (object.position.x + object.position.y + asset.footprint.width + asset.footprint.height) * 100
      room.eventMode = 'static'; room.cursor = 'pointer'; (room as Graphics & { objectId: string }).objectId = object.id
      layers.objects.addChild(room)
      const label = new Text({ text: object.label ?? asset.name, style: { fontFamily: 'serif', fontSize: 14, fill: 0xf5eee1, fontWeight: '600', stroke: { color: 0x2d241f, width: 3 } } })
      label.anchor.set(.5, 1); label.position.set(p.x, p.y - depth / 2 - wall - 8); label.zIndex = room.zIndex + 1; label.eventMode = 'none'; layers.objects.addChild(label)
      if (object.binding?.kind === 'location') locations.set(object.binding.locationName, object)
      if (selectedId === object.id) { const outline = new Graphics().poly([p.x, p.y - depth / 2, p.x + width / 2, p.y, p.x, p.y + depth / 2, p.x - width / 2, p.y]).stroke({ color: 0xffffff, width: 5 }); outline.zIndex = room.zIndex + 2; layers.preview.addChild(outline) }
      continue
    }
    const texture = loader.texture(asset.sprite.frame); if (!texture) continue
    if (overlay && object.binding?.kind === 'person') continue
    const p = objectGroundPoint(object, asset.footprint, scene.size); const sprite = new Sprite(texture); sprite.anchor.set(asset.anchor.x, asset.anchor.y)
    const targetWidth = Math.max(64, asset.footprint.width * 64)
    const uniformScale = targetWidth / Math.max(1, texture.width)
    sprite.scale.set(uniformScale); sprite.position.set(p.x, p.y + asset.sortOffset); sprite.zIndex = (object.position.x + object.position.y + asset.footprint.width + asset.footprint.height - 2) * 100 + asset.sortOffset
    if (asset.id === 'street-lamp' && overlay?.timeOfDay !== 'night') sprite.tint = 0xd8d8c9
    sprite.label = object.id; sprite.eventMode = 'static'; sprite.cursor = 'pointer'; (sprite as Sprite & { objectId: string }).objectId = object.id; layers.objects.addChild(sprite)
    if (object.binding?.kind === 'location') locations.set(object.binding.locationName, object)
    if (selectedId === object.id) {
      const outline = new Graphics().roundRect(p.x - sprite.width / 2 - 8, p.y - sprite.height - 8, sprite.width + 16, sprite.height + 16, 10).stroke({ color: 0xffffff, width: 4 })
      outline.zIndex = sprite.zIndex - 1; layers.preview.addChild(outline)
    }
    if (scene.lockedObjectIds.includes(object.id)) {
      const lock = new Graphics().roundRect(p.x + sprite.width / 2 - 7, p.y - sprite.height - 8, 16, 15, 3).fill({ color: 0x435649 }).roundRect(p.x + sprite.width / 2 - 4, p.y - sprite.height - 14, 10, 10, 5).stroke({ color: 0x435649, width: 3 })
      lock.zIndex = sprite.zIndex + 2; layers.preview.addChild(lock)
    }
  }
  if (overlay) for (const person of overlay.persons) {
    const building = locations.get(person.locationName); if (!building) continue
    const buildingAsset = assetById.get(building.assetId); if (!buildingAsset) continue
    const avatar = scene.objects.find(o => o.binding?.kind === 'person' && o.binding.personId === person.personId); const asset = avatar && assetById.get(avatar.assetId); if (!asset) continue
    const walking = /walk|走|通勤/i.test(person.activity)
    const frameNames = walking
      ? [asset.sprite.states?.walk1, asset.sprite.states?.walk2].filter((frame): frame is string => !!frame)
      : [asset.sprite.states?.activity ?? asset.sprite.states?.idle ?? asset.sprite.frame]
    const texture = loader.texture(frameNames[0]!); if (!texture) continue
    const contact = objectGroundPoint(building, buildingAsset.footprint, scene.size)
    const p = { x: contact.x, y: contact.y + 12 }; const sprite = new Sprite(texture); sprite.anchor.set(.5, 1); sprite.width = 36; sprite.height = 48; sprite.position.set(p.x, p.y); sprite.zIndex = (building.position.x + building.position.y + buildingAsset.footprint.width + buildingAsset.footprint.height - 2) * 100 + 50
    ;(sprite as Sprite & { animationFrames?: string[] }).animationFrames = frameNames
    layers.people.addChild(sprite)
  }
  // Night is expressed through local lights. A rectangular full-map tint reads as a grey veil
  // and exposes the scene bounds, so it is intentionally omitted.
  if (overlay?.timeOfDay === 'night') for (const object of scene.objects) {
    const asset = assetById.get(object.assetId); if (asset?.category !== 'building') continue
    const p = objectGroundPoint(object, asset.footprint, scene.size)
    const width = asset.footprint.width * 64
    const height = asset.footprint.height * 32
    layers.weather.addChild(new Graphics().circle(p.x, p.y - height * .62, 15).fill({ color: 0xffc96b, alpha: .09 }))
    layers.weather.addChild(new Graphics()
      .roundRect(p.x - width * .27, p.y - height * .58, 7, 8, 2)
      .roundRect(p.x + width * .08, p.y - height * .54, 7, 8, 2)
      .fill({ color: 0xffd98a, alpha: .92 }))
  }
  if (overlay?.timeOfDay === 'night') for (const object of scene.objects) {
    const asset = assetById.get(object.assetId); if (asset?.id !== 'street-lamp') continue
    const p = objectGroundPoint(object, asset.footprint, scene.size)
    layers.weather.addChild(new Graphics().circle(p.x, p.y - 24, 13).fill({ color: 0xffd98a, alpha: .16 }))
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
