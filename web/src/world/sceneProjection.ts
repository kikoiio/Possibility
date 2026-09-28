import type { SceneDocument, SceneDocumentV2, SceneThemeManifest, SceneThemeManifestV2 } from '@possibility/scene-contract'

function footprint(asset: SceneThemeManifestV2['assets'][number]) {
  return asset.geometry.footprintCells.reduce((size, cell) => ({ width: Math.max(size.width, cell.x + 1), height: Math.max(size.height, cell.y + 1) }), { width: 1, height: 1 })
}

export function projectTheme(theme: SceneThemeManifestV2): SceneThemeManifest {
  return {
    id: theme.id, name: theme.name, schemaVersion: 1, tileSize: theme.tileSize,
    sheets: theme.sheets.map(({ id, src }) => ({ id, src })),
    assets: theme.assets.map(asset => {
      const size = footprint(asset)
      const category = asset.category === 'surface' ? 'terrain'
        : asset.category === 'path' ? 'road'
          : asset.category === 'person' ? 'person'
            : asset.category === 'nature' ? 'nature'
              : asset.category === 'building' || asset.category === 'structure' ? 'building' : 'decoration'
      return {
        id: asset.id, themeId: theme.id, category, name: asset.name, sprite: { sheetId: asset.sprite.sheetId, frame: asset.sprite.frame, states: asset.sprite.states },
        thumbnail: asset.thumbnail, footprint: size,
        anchor: { x: asset.geometry.groundContactPixel.x / asset.sprite.frameSize.width, y: asset.geometry.groundContactPixel.y / asset.sprite.frameSize.height },
        sortOffset: asset.geometry.sortBias, tags: [],
        capabilities: { placeable: asset.capabilities.placeable, repeatable: false, semanticLocation: asset.capabilities.semanticLocation, semanticPerson: asset.capabilities.semanticPerson },
      }
    }),
  }
}

export function projectSpace(scene: SceneDocumentV2, spaceId: string): SceneDocument {
  const space = scene.spaces.find(item => item.id === spaceId) ?? scene.spaces.find(item => item.id === scene.defaultSpaceId)!
  const residents = scene.spaces.flatMap(item => item.objects).filter(object => object.binding?.kind === 'person')
  const objectIds = new Set(space.objects.map(object => object.id))
  return {
    schemaVersion: 1, themeId: scene.themeId, version: scene.version, size: space.size,
    terrain: space.surface, paths: space.paths.map(path => ({ ...path, category: path.category === 'water' ? 'water' : 'road' })),
    objects: [...space.structures, ...space.objects, ...residents.filter(object => !objectIds.has(object.id))],
    lockedObjectIds: [], lockedAreas: scene.lockedAreas.filter(area => area.spaceId === space.id).map(({ x, y, width, height }) => ({ x, y, width, height })),
  }
}
