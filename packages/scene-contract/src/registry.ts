import { validateThemeManifest } from './catalog'
import type { SceneThemeManifest, SceneThemeManifestV2, SceneValidationIssue } from './types'
import { contemporaryTheme } from './themes/contemporary'
import { testTheme } from './themes/test-theme'
import { mistManorTheme } from './themes/mist-manor'

export type RegisteredSceneTheme = SceneThemeManifest | SceneThemeManifestV2
const themes = new Map<string, RegisteredSceneTheme>()

export function registerTheme(theme: RegisteredSceneTheme): void {
  if (themes.has(theme.id)) throw new Error(`scene theme already registered: ${theme.id}`)
  const issues = validateThemeManifest(theme)
  if (issues.length) throw new Error(`invalid scene theme ${theme.id}: ${issues.map(x => x.code).join(', ')}`)
  themes.set(theme.id, theme)
}
export function getTheme(themeId: string): RegisteredSceneTheme | undefined { return themes.get(themeId) }
export function requireTheme(themeId: string): RegisteredSceneTheme {
  const theme = getTheme(themeId)
  if (!theme) throw new Error(`unknown scene theme: ${themeId}`)
  return theme
}
export function getCriticalSheets(themeId: string): string[] {
  const theme = requireTheme(themeId)
  return theme.sheets.filter(sheet => !('loading' in sheet) || sheet.loading !== 'deferred').map(sheet => sheet.id)
}
export function getDeferredSheets(themeId: string): string[] {
  const theme = requireTheme(themeId)
  return theme.sheets.filter(sheet => 'loading' in sheet && sheet.loading === 'deferred').map(sheet => sheet.id)
}
export function validateRegisteredTheme(themeId: string): SceneValidationIssue[] {
  const theme = getTheme(themeId)
  return theme ? validateThemeManifest(theme) : [{ code: 'unknown_theme', path: 'themeId', message: `未知主题：${themeId}` }]
}

registerTheme(contemporaryTheme)
registerTheme(testTheme)
registerTheme(mistManorTheme)
