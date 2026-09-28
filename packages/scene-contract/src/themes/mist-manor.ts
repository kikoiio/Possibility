import type { GridPoint, SceneAssetDefinitionV2, SceneThemeManifestV2 } from '../types'

const THEME_ID = 'mist-manor'
const rectCells = (width: number, height: number): GridPoint[] => Array.from({ length: width * height }, (_, index) => ({ x: index % width, y: Math.floor(index / width) }))

function asset(input: {
  id: string; category: SceneAssetDefinitionV2['category']; name: string; sheetId: string; frame: string
  frameSize: { width: number; height: number }; footprint: { width: number; height: number }
  groundContactPixel?: GridPoint; semanticLocation?: boolean; semanticPerson?: boolean; enterable?: boolean; interactive?: boolean
  states?: Record<string, string>; blocked?: boolean
}): SceneAssetDefinitionV2 {
  const contact = input.groundContactPixel ?? { x: input.frameSize.width / 2, y: input.frameSize.height }
  return {
    id: input.id, themeId: THEME_ID, category: input.category, name: input.name,
    sprite: { sheetId: input.sheetId, frame: input.frame, states: input.states ?? { default: input.frame }, frameSize: input.frameSize },
    thumbnail: `/scene-assets/mist-manor/exterior-core.png#${input.frame}`,
    geometry: {
      footprintCells: rectCells(input.footprint.width, input.footprint.height),
      groundContactCell: { x: (input.footprint.width - 1) / 2, y: (input.footprint.height - 1) / 2 },
      groundContactPixel: contact, elevation: 0,
      visualBounds: { x: 0, y: 0, width: input.frameSize.width, height: input.frameSize.height },
      occlusionBounds: [{ x: 0, y: 0, width: input.frameSize.width, height: input.frameSize.height }], sortBias: 0,
    },
    connectors: [],
    navigation: { walkableCells: [], blockedCells: input.blocked === false ? [] : rectCells(input.footprint.width, input.footprint.height), entrances: input.enterable ? [{ x: Math.floor(input.footprint.width / 2), y: input.footprint.height - 1 }] : [] },
    capabilities: { placeable: true, semanticLocation: !!input.semanticLocation, semanticPerson: !!input.semanticPerson, enterable: !!input.enterable, interactive: input.interactive ?? true },
  }
}

const environment = (id: string, frame: string, category: 'surface' | 'path', name: string) => asset({
  id, category, name, sheetId: 'environment', frame, frameSize: { width: 444, height: 222 }, footprint: { width: 1, height: 1 }, blocked: false,
})

const people = ['ada', 'bo', 'cora', 'dan', 'eli', 'faye'].map((name, index) => asset({
  id: `mist-resident-${index + 1}`, category: 'person', name: `雾影庄居民 ${index + 1}`, sheetId: 'residents', frame: `person-${name}-idle`,
  frameSize: { width: 342, height: 256 }, footprint: { width: 1, height: 1 }, semanticPerson: true, blocked: false,
  states: { idle: `person-${name}-idle`, walk1: `person-${name}-walk-1`, walk2: `person-${name}-walk-2`, activity: `person-${name}-walk-1` },
}))

export const mistManorTheme: SceneThemeManifestV2 = {
  id: THEME_ID, name: '雾影庄', schemaVersion: 2, tileSize: { width: 64, height: 32 },
  sheets: [
    { id: 'exterior-core', src: '/scene-assets/mist-manor/exterior-core.png', loading: 'critical' },
    { id: 'environment', src: '/scene-assets/contemporary/environment-atlas-clean.png', loading: 'critical' },
    { id: 'residents', src: '/scene-assets/contemporary/persons-atlas-clean.png', loading: 'critical' },
  ],
  assets: [
    environment('mist-grass', 'terrain-grass', 'surface', '山间草地'),
    environment('mist-stone', 'terrain-stone', 'surface', '庄园石地'),
    environment('mist-road', 'road-straight', 'path', '旧石路'),
    asset({ id: 'manor-main', category: 'building', name: '雾影庄主楼', sheetId: 'exterior-core', frame: 'manor-main', frameSize: { width: 582, height: 484 }, footprint: { width: 9, height: 7 }, groundContactPixel: { x: 291, y: 484 }, semanticLocation: true, enterable: true }),
    asset({ id: 'manor-gatehouse', category: 'building', name: '门房小屋', sheetId: 'exterior-core', frame: 'gatehouse', frameSize: { width: 277, height: 322 }, footprint: { width: 5, height: 5 }, groundContactPixel: { x: 139, y: 322 }, semanticLocation: true, enterable: true }),
    asset({ id: 'manor-greenhouse', category: 'building', name: '温室花房', sheetId: 'exterior-core', frame: 'greenhouse', frameSize: { width: 350, height: 332 }, footprint: { width: 5, height: 5 }, groundContactPixel: { x: 175, y: 332 }, semanticLocation: true, enterable: true }),
    asset({ id: 'manor-courtyard', category: 'structure', name: '庭院池塘', sheetId: 'exterior-core', frame: 'courtyard-pond', frameSize: { width: 401, height: 390 }, footprint: { width: 6, height: 5 }, groundContactPixel: { x: 201, y: 390 }, blocked: false }),
    asset({ id: 'manor-trail', category: 'building', name: '后山散步道', sheetId: 'exterior-core', frame: 'mountain-trail', frameSize: { width: 286, height: 437 }, footprint: { width: 5, height: 6 }, groundContactPixel: { x: 143, y: 437 }, semanticLocation: true, enterable: true }),
    asset({ id: 'manor-town-road', category: 'structure', name: '通往白雾町的道路', sheetId: 'exterior-core', frame: 'town-road', frameSize: { width: 264, height: 352 }, footprint: { width: 5, height: 5 }, groundContactPixel: { x: 132, y: 352 }, blocked: false }),
    asset({ id: 'manor-garden-light', category: 'effect', name: '庭院灯与枫树', sheetId: 'exterior-core', frame: 'garden-lantern-maple', frameSize: { width: 232, height: 260 }, footprint: { width: 4, height: 4 }, groundContactPixel: { x: 116, y: 260 }, blocked: false }),
    asset({ id: 'manor-room-hall', category: 'building', name: '大厅室内', sheetId: 'exterior-core', frame: 'courtyard-pond', frameSize: { width: 401, height: 390 }, footprint: { width: 5, height: 4 }, groundContactPixel: { x: 201, y: 390 }, semanticLocation: true, enterable: true }),
    asset({ id: 'manor-room-study', category: 'building', name: '书房室内', sheetId: 'exterior-core', frame: 'garden-lantern-maple', frameSize: { width: 232, height: 260 }, footprint: { width: 4, height: 4 }, groundContactPixel: { x: 116, y: 260 }, semanticLocation: true, enterable: true }),
    asset({ id: 'manor-room-dining', category: 'building', name: '餐厅室内', sheetId: 'exterior-core', frame: 'greenhouse', frameSize: { width: 350, height: 332 }, footprint: { width: 4, height: 4 }, groundContactPixel: { x: 175, y: 332 }, semanticLocation: true, enterable: true }),
    asset({ id: 'manor-room-library', category: 'building', name: '图书室室内', sheetId: 'exterior-core', frame: 'gatehouse', frameSize: { width: 277, height: 322 }, footprint: { width: 4, height: 4 }, groundContactPixel: { x: 139, y: 322 }, semanticLocation: true, enterable: true }),
    ...people,
  ],
}
