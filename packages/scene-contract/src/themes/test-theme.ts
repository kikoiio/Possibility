import type { SceneThemeManifest } from '../types'

export const testTheme: SceneThemeManifest = {
  id: 'test-minimal', name: '测试主题', schemaVersion: 1, tileSize: { width: 64, height: 32 },
  sheets: [{ id: 'test', src: '/test-atlas.png' }],
  assets: [
    ['test-terrain','terrain'], ['test-road','road'], ['test-water','water'], ['test-building','building'], ['test-nature','nature'], ['test-decoration','decoration'], ['test-person','person'],
  ].map(([id, category]) => ({
    id, category, themeId: 'test-minimal', name: id, sprite: { sheetId: 'test', frame: id }, footprint: { width: 1, height: 1 }, anchor: { x: .5, y: 1 }, sortOffset: 0, tags: [],
    capabilities: { placeable: ['building','nature','decoration','person'].includes(category), repeatable: false, semanticLocation: category === 'building', semanticPerson: category === 'person' },
  })) as SceneThemeManifest['assets'],
}
