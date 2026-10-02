/**
 * S3 进入世界面板的初始地点解析(纯函数):
 * 传入地点(如居民卡带来的居民当前地点)经校验后优先;
 * 失效时回退 persona 记忆地点或列表首项,并给出提示文案。
 */
export interface SceneEntryResolution {
  location: string
  notice: string | null
}

export function resolveSceneEntryLocation(
  requested: string,
  personaLocation: string | null,
  locations: { name: string }[],
): SceneEntryResolution {
  if (requested) {
    if (locations.some(item => item.name === requested)) return { location: requested, notice: null }
    return {
      location: personaLocation ?? locations[0]?.name ?? '',
      notice: `「${requested}」已不在当前地点列表中，已为你选择其他地点。`,
    }
  }
  return { location: personaLocation ?? locations[0]?.name ?? '', notice: null }
}
