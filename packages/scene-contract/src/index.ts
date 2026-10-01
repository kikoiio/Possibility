/**
 * 场景生活投影(S2 起 scene-contract 唯一保留类型)。
 * 2D 场景文档/操作/校验已全部退役,体素文档见 @possibility/voxel-contract;
 * 此处仅保留生活投影——世界页生活模式把居民位置/情绪/天气叠到体素视口上。
 */
export interface SceneLifeOverlay {
  timelineId: string; simNow: string; weather: string | null; timeOfDay: 'day' | 'dusk' | 'night' | 'dawn'
  persons: { personId: string; locationName: string; activity: string; mood: string }[]
  locationStates: { locationName: string; visualState: string }[]
}
