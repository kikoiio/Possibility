import type { AssetCategory, SceneAssetDefinition, SceneThemeManifest } from '../types'

const data: [string, AssetCategory, string, number, number, string[]][] = [
  ['terrain-grass','terrain','草地',1,1,['base']], ['terrain-path-edge','terrain','草地边缘',1,1,['edge']], ['terrain-stone','terrain','石地',1,1,['base']],
  ['road-single','road','道路端点',1,1,['road']], ['road-straight','road','直路',1,1,['road']], ['road-corner','road','弯路',1,1,['road']], ['road-tee','road','三岔路',1,1,['road']], ['road-cross','road','十字路',1,1,['road']],
  ['water-edge','water','水岸',1,1,['water']], ['water-inner','water','水面',1,1,['water']],
  ['home-small','building','小屋',3,3,['home']], ['home-row','building','联排住宅',4,3,['home']], ['cafe-corner','building','街角咖啡馆',4,4,['cafe']], ['grocery-small','building','杂货店',3,3,['shop']], ['bookshop-small','building','书店',3,3,['shop']], ['station-stop','building','车站',4,3,['transport']], ['park-pavilion','building','公园亭',3,3,['park']], ['clinic-small','building','诊所',4,3,['care']],
  ['tree-round','nature','圆冠树',2,2,['tree']], ['tree-tall','nature','高树',2,2,['tree']], ['shrub','nature','灌木',1,1,['plant','repeatable']], ['flower-bed','nature','花坛',1,1,['plant','repeatable']], ['wildflower','nature','野花',1,1,['plant','repeatable']], ['stone-boulder','nature','石块',1,1,['stone']], ['planter','nature','花盆',1,1,['plant']],
  ['bench','decoration','长椅',1,1,['street']], ['street-lamp','decoration','路灯',1,1,['light']], ['cafe-table','decoration','咖啡桌椅',2,1,['cafe']], ['sign-board','decoration','招牌',1,1,['sign']], ['low-fence','decoration','矮围栏',1,1,['fence']], ['bus-stop-sign','decoration','站牌',1,1,['transport']], ['mailbox','decoration','邮箱',1,1,['street']], ['fountain-small','decoration','小喷泉',2,2,['park']],
  ['person-ada','person','Ada',1,1,['resident']], ['person-bo','person','Bo',1,1,['resident']], ['person-cora','person','Cora',1,1,['resident']], ['person-dan','person','Dan',1,1,['resident']], ['person-eli','person','Eli',1,1,['resident']], ['person-faye','person','Faye',1,1,['resident']],
]
export const contemporaryTheme: SceneThemeManifest = {
  id: 'contemporary-daily-life', name: '当代日常生活', schemaVersion: 1, tileSize: { width: 64, height: 32 },
  sheets: [{ id: 'world', src: '/scene-assets/contemporary/world-atlas.png' }, { id: 'environment', src: '/scene-assets/contemporary/environment-atlas.png' }, { id: 'persons', src: '/scene-assets/contemporary/persons-atlas.png' }],
  assets: data.map(([id, category, name, width, height, tags]) => {
    const person = category === 'person'
    const envFrames: Record<string, string> = {
      'terrain-grass': 'terrain-grass', 'terrain-path-edge': 'terrain-path-edge', 'terrain-stone': 'terrain-stone', 'stone-boulder': 'terrain-stone',
      'road-single': 'road-single', 'road-straight': 'road-straight', 'road-corner': 'road-corner', 'road-tee': 'road-tee', 'road-cross': 'road-cross',
      'water-edge': 'water-edge', 'water-inner': 'water-inner', 'low-fence': 'low-fence', 'sign-board': 'sign-board', 'mailbox': 'mailbox', 'cafe-table': 'cafe-table', 'bus-stop-sign': 'bus-stop-sign', 'planter': 'planter',
    }
    const sheetId = person ? 'persons' : envFrames[id] ? 'environment' : 'world'
    const frame = person ? `${id}-idle` : envFrames[id] ?? id
    const states: Record<string, string> | undefined = category === 'person' ? { idle: `${id}-idle`, walk1: `${id}-walk-1`, walk2: `${id}-walk-2`, activity: `${id}-walk-1` } : undefined
    const asset: SceneAssetDefinition = {
      id, themeId: 'contemporary-daily-life', category, name,
      sprite: { sheetId, frame, ...(states ? { states } : {}) }, footprint: { width, height }, anchor: { x: 0.5, y: 1 }, sortOffset: 0, tags,
      capabilities: { placeable: ['building','nature','decoration','person'].includes(category), repeatable: tags.includes('repeatable'), semanticLocation: category === 'building', semanticPerson: person },
    }
    return asset
  }),
}
