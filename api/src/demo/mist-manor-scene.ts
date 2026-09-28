import type { GridPoint, SceneDocumentV2, SceneObject, SceneRegion, SceneSpace } from '@possibility/scene-contract'

export interface MistManorResident { id: string; name: string; location?: string }

const cells = (columns: number, rows: number): GridPoint[] => Array.from({ length: columns * rows }, (_, index) => ({ x: index % columns, y: Math.floor(index / columns) }))
const fill = (columns: number, rows: number, assetId: string) => cells(columns, rows).map(point => ({ ...point, assetId }))
const rect = (x: number, y: number, width: number, height: number) => Array.from({ length: width * height }, (_, index) => ({ x: x + index % width, y: y + Math.floor(index / width) }))

function locationObject(id: string, assetId: string, position: GridPoint, locationName: string): SceneObject {
  return { id, assetId, position, binding: { kind: 'location', locationName }, label: locationName, purpose: null }
}

function region(id: string, locationName: string, area: GridPoint[], entryPoint: GridPoint, interactionPoint = entryPoint): SceneRegion {
  return { id, locationName, cells: area, entryPoint, interactionPoint }
}

export function createMistManorScene(residents: MistManorResident[]): SceneDocumentV2 {
  const exteriorSize = { columns: 30, rows: 20 }
  const interiorSize = { columns: 18, rows: 13 }
  const locationAnchors: Record<string, GridPoint> = {
    '大厅': { x: 14, y: 9 }, '书房': { x: 13, y: 8 }, '餐厅': { x: 15, y: 8 }, '图书室': { x: 14, y: 7 },
    '温室花房': { x: 25, y: 8 }, '门房小屋': { x: 5, y: 15 }, '后山散步道': { x: 25, y: 15 },
  }
  const residentObjects: SceneObject[] = residents.slice(0, 6).map((resident, index) => ({
    id: `mist-resident-${resident.id}`, assetId: `mist-resident-${index + 1}`,
    position: locationAnchors[resident.location ?? '大厅'] ?? { x: 13 + index % 3, y: 10 + Math.floor(index / 3) },
    binding: { kind: 'person', personId: resident.id }, label: resident.name, purpose: null,
  }))
  const exterior: SceneSpace = {
    id: 'exterior', name: '雾影庄外景', kind: 'exterior', size: exteriorSize,
    surface: fill(exteriorSize.columns, exteriorSize.rows, 'mist-grass'),
    paths: [{ id: 'approach-road', category: 'road', assetId: 'mist-road', cells: [...rect(0, 10, 14, 1), ...rect(13, 8, 1, 3)] }],
    structures: [
      locationObject('main-manor', 'manor-main', { x: 10, y: 2 }, '大厅'),
      locationObject('gatehouse', 'manor-gatehouse', { x: 1, y: 11 }, '门房小屋'),
      locationObject('greenhouse', 'manor-greenhouse', { x: 23, y: 2 }, '温室花房'),
      { id: 'courtyard', assetId: 'manor-courtyard', position: { x: 14, y: 12 }, binding: null, label: '庭院', purpose: null },
      locationObject('mountain-trail', 'manor-trail', { x: 24, y: 12 }, '后山散步道'),
      { id: 'garden-light', assetId: 'manor-garden-light', position: { x: 8, y: 13 }, binding: null, label: '庭院灯', purpose: null },
    ],
    objects: residentObjects,
    regions: [
      region('exterior-main', '大厅', rect(10, 2, 9, 7), { x: 14, y: 9 }),
      region('exterior-gate', '门房小屋', rect(1, 11, 5, 5), { x: 5, y: 15 }),
      region('exterior-greenhouse', '温室花房', rect(23, 2, 5, 5), { x: 25, y: 7 }),
      region('exterior-trail', '后山散步道', rect(24, 12, 5, 6), { x: 24, y: 15 }),
    ],
    navigation: { walkableCells: cells(exteriorSize.columns, exteriorSize.rows), blockedCells: [], entrances: [{ x: 0, y: 10 }, { x: 14, y: 9 }] },
  }
  const interior: SceneSpace = {
    id: 'main-house-interior', name: '主楼室内', kind: 'interior', size: interiorSize,
    surface: fill(interiorSize.columns, interiorSize.rows, 'mist-stone'), paths: [], structures: [],
    objects: [
      locationObject('room-hall', 'manor-room-hall', { x: 6, y: 7 }, '大厅'),
      locationObject('room-study', 'manor-room-study', { x: 1, y: 1 }, '书房'),
      locationObject('room-dining', 'manor-room-dining', { x: 12, y: 1 }, '餐厅'),
      locationObject('room-library', 'manor-room-library', { x: 1, y: 8 }, '图书室'),
    ],
    regions: [
      region('room-region-hall', '大厅', rect(6, 7, 5, 4), { x: 8, y: 10 }),
      region('room-region-study', '书房', rect(1, 1, 4, 4), { x: 4, y: 4 }),
      region('room-region-dining', '餐厅', rect(12, 1, 4, 4), { x: 12, y: 4 }),
      region('room-region-library', '图书室', rect(1, 8, 4, 4), { x: 4, y: 9 }),
    ],
    navigation: { walkableCells: cells(interiorSize.columns, interiorSize.rows), blockedCells: [], entrances: [{ x: 8, y: 12 }] },
  }
  return {
    schemaVersion: 2, themeId: 'mist-manor', version: 0, defaultSpaceId: 'exterior', spaces: [exterior, interior],
    portals: [{
      id: 'main-house-door', from: { spaceId: 'exterior', position: { x: 14, y: 9 }, facing: 'north-east' },
      to: { spaceId: 'main-house-interior', position: { x: 8, y: 12 }, facing: 'north-east' }, transition: 'camera',
    }],
    lockedObjectIds: exterior.structures.map(object => object.id),
    lockedAreas: [{ spaceId: 'exterior', x: 0, y: 0, width: 30, height: 20 }, { spaceId: 'main-house-interior', x: 0, y: 0, width: 18, height: 13 }],
  }
}
