import { describe, expect, it } from 'vitest'
import { assetsByCategory, compactCatalogForPrompt, findAsset, validateThemeManifest } from '../src/catalog'
import { contemporaryTheme } from '../src/themes/contemporary'
import { testTheme } from '../src/themes/test-theme'

describe('theme catalog', () => {
  it('validates production and minimal manifests', () => { expect(validateThemeManifest(contemporaryTheme)).toEqual([]); expect(validateThemeManifest(testTheme)).toEqual([]) })
  it('finds and filters assets and creates a compact prompt catalog', () => {
    expect(findAsset(contemporaryTheme, 'cafe-corner')?.category).toBe('building')
    expect(assetsByCategory(contemporaryTheme, 'person')).toHaveLength(6)
    expect(compactCatalogForPrompt(contemporaryTheme)).toContain('cafe-corner|building|4x4')
  })
  it('reports duplicate IDs, missing sheets, and theme mismatches', () => {
    const broken = { ...testTheme, assets: [testTheme.assets[0]!, { ...testTheme.assets[0]!, themeId: 'wrong', sprite: { sheetId: 'missing', frame: '' } }] }
    expect(validateThemeManifest(broken).map(i => i.code)).toEqual(['duplicate_asset_id','theme_mismatch','unknown_sheet','missing_frame'])
  })
})
