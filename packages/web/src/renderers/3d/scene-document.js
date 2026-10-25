export { findRegion, findObject, sceneLayout, validateSceneDocument, validateSpatialLayout, formatDiagnostic, islandContains } from './scene-validation.js';

export function createLibraryDescription(document) {
  return `创建“${document.title}”：可进入的临水藏书屋、门廊、桥和室内阅读空间，保留物件身份与可编辑尺寸。`;
}

// 村庄级示例：一栋 library（书院）、多栋 house、path 石板路。兼作村庄生成的字段参考与测试夹具。
export const villageScene = {
  schemaVersion: 1,
  id: 'reed-fishing-village',
  title: '芦汀渔村',
  style: { palette: 'wetland-sage', voxelUnit: 0.42, seed: 83 },
  regions: [
    { id: 'water', kind: 'water', center: [0, 0], size: [2000, 2000], elevation: -0.43 },
    { id: 'island', kind: 'island', center: [0, 0], radius: 16, elevation: 0.8, irregularity: 0.06 },
    { id: 'landing', kind: 'island', center: [15, 6], radius: 4.1, elevation: 0.61, irregularity: 0 },
  ],
  objects: [
    {
      id: 'library', kind: 'library', name: '村中书院',
      transform: { position: [0, 0, 0], rotation: 0 },
      bounds: { width: 9, depth: 7, wallHeight: 4.7, floor: 1.48 },
      roof: { kind: 'gable', rise: 2.65, overhang: 0.65 },
      entrance: { wall: 'front', width: 2.6, height: 3.8 },
      windows: [{ wall: 'front', offset: -3 }, { wall: 'front', offset: 3 }],
      parts: ['walls', 'roof', 'bookshelves', 'reading-table', 'lamp'],
      attachments: [{ target: 'porch', relation: 'front-door' }],
    },
    {
      id: 'porch', kind: 'porch', name: '临水门廊',
      transform: { position: [0, 0, 4.65], rotation: 0 },
      bounds: { width: 6.5, depth: 2.6, floor: 1.32 },
      attachments: [{ target: 'library', relation: 'entrance' }],
    },
    {
      id: 'bridge', kind: 'bridge', name: '村口木桥',
      from: { region: 'island', point: [7.2, 0.9, 4.5] },
      to: { region: 'landing', point: [16.5, 0.9, 6] },
      width: 2.25, arch: 1.25, segments: 23,
    },
    {
      id: 'h1', kind: 'house', name: '渔家甲',
      transform: { position: [-8.5, 0, -5], rotation: 0 },
      bounds: { width: 4.6, depth: 3.6, wallHeight: 3.1, floor: 1.1 },
      roof: { kind: 'gable', rise: 1.3, overhang: 0.4 },
      entrance: { wall: 'front', width: 1.5, height: 2.3 },
    },
    {
      id: 'h2', kind: 'house', name: '渔家乙',
      transform: { position: [8.5, 0, -4.5], rotation: 0 },
      bounds: { width: 4.6, depth: 3.6, wallHeight: 3.1, floor: 1.1 },
      roof: { kind: 'gable', rise: 1.3, overhang: 0.4 },
      entrance: { wall: 'front', width: 1.5, height: 2.3 },
    },
    {
      id: 'h3', kind: 'house', name: '渔家丙',
      transform: { position: [-8.5, 0, 5.5], rotation: 0 },
      bounds: { width: 4.6, depth: 3.6, wallHeight: 3.1, floor: 1.1 },
      roof: { kind: 'gable', rise: 1.3, overhang: 0.4 },
      entrance: { wall: 'front', width: 1.5, height: 2.3 },
    },
    {
      id: 'h4', kind: 'house', name: '渔家丁',
      transform: { position: [-2, 0, 10], rotation: 0 },
      bounds: { width: 4.6, depth: 3.6, wallHeight: 3.1, floor: 1.1 },
      roof: { kind: 'gable', rise: 1.3, overhang: 0.4 },
      entrance: { wall: 'front', width: 1.5, height: 2.3 },
    },
    { id: 'lane-main', kind: 'path', name: '村中石板路', points: [[1.8, 6.8], [1.8, 12.3]], width: 1.0 },
    { id: 'villager-1', kind: 'character', name: '老舟', position: [1.8, 0.8, 7.2], route: [[1.8, 7.2], [1.8, 11.6]], speed: 1.1 },
    { id: 'villager-2', kind: 'character', name: '阿苇', position: [-5.5, 0.8, 8] },
    { id: 'tree-north', kind: 'tree', position: [-12.5, 0.8, -3.5], scale: 0.35, seed: 663 },
    { id: 'tree-west', kind: 'tree', position: [-12.5, 0.8, 6.5], scale: 0.35, seed: 1581 },
    { id: 'tree-east', kind: 'tree', position: [12, 0.8, -2], scale: 0.35, seed: 1377 },
    { id: 'tree-landing', kind: 'tree', position: [15, 0.61, 8.7], scale: 0.3, seed: 1785 },
  ],
};


export const libraryScene = {
  schemaVersion: 1,
  id: 'reed-island-library',
  title: '芦汀藏书屋',
  style: {
    palette: 'wetland-sage',
    voxelUnit: 0.42,
    seed: 83,
  },
  regions: [
    { id: 'water', kind: 'water', center: [0, 0], size: [2000, 2000], elevation: -0.43 },
    { id: 'island', kind: 'island', center: [0, 0], radius: 11.5, elevation: 0.8, irregularity: 0.08 },
    { id: 'landing', kind: 'island', center: [15, 6], radius: 4.1, elevation: 0.61, irregularity: 0 },
  ],
  objects: [
    {
      id: 'library', kind: 'library', name: '藏书屋',
      transform: { position: [0, 0, 0], rotation: 0 },
      bounds: { width: 9, depth: 7, wallHeight: 4.7, floor: 1.48 },
      roof: { kind: 'gable', rise: 2.65, overhang: 0.65 },
      entrance: { wall: 'front', width: 2.6, height: 3.8 },
      windows: [{ wall: 'front', offset: -3 }, { wall: 'front', offset: 3 }],
      parts: ['walls', 'roof', 'bookshelves', 'reading-table', 'lamp'],
      attachments: [{ target: 'porch', relation: 'front-door' }],
    },
    {
      id: 'porch', kind: 'porch', name: '临水门廊',
      transform: { position: [0, 0, 4.65], rotation: 0 },
      bounds: { width: 6.5, depth: 2.6, floor: 1.32 },
      attachments: [{ target: 'library', relation: 'entrance' }],
    },
    {
      id: 'bridge', kind: 'bridge', name: '弧形木桥',
      from: { region: 'island', point: [7.2, 0.9, 4.5] },
      to: { region: 'landing', point: [16.5, 0.9, 6] },
      width: 2.25, arch: 1.25, segments: 23,
    },
    { id: 'tree-north', kind: 'tree', position: [-5, 0.8, -6.5], scale: 0.6, seed: 663 },
    { id: 'tree-east', kind: 'tree', position: [7.8, 0.8, -1], scale: 0.6, seed: 1377 },
    { id: 'tree-west', kind: 'tree', position: [-7, 0.8, 5], scale: 0.75, seed: 1581 },
    { id: 'tree-landing', kind: 'tree', position: [15, 0.61, 8.7], scale: 0.3, seed: 1785 },
  ],
};
