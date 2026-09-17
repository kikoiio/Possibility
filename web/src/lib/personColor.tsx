/** 人物颜色：按 ID 稳定分配的标识色，事件流 / 地点面板 / 人物抽屉统一使用 */
const PALETTE = [
  '#b5472e', // 朱
  '#46618c', // 靛
  '#3f6f5f', // 松绿
  '#7c5d8f', // 藤紫
  '#a06b2c', // 赭
  '#2f7d8c', // 青
  '#b5566f', // 棠红
  '#5a7052', // 苔绿
  '#8c4a3a', // 砖褐
  '#4a6b8c', // 灰蓝
  '#6b5d3f', // 土金
  '#3d5c46', // 深竹
]

export function personColor(personId: string): string {
  // FNV-1a + 末尾混合：旧 charCode 线性哈希对 UUID（大量共享字符段）分布极差，
  // 8 色盘下 6 人撞 3 对；混合后低位熵充分，按 ID 稳定且不随人物增删漂移
  let h = 2166136261
  for (let i = 0; i < personId.length; i++) {
    h ^= personId.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  h ^= h >>> 15
  h = Math.imul(h, 2246822519)
  h ^= h >>> 13
  return PALETTE[(h >>> 0) % PALETTE.length]
}

/** 无头像时的色块首字 */
export function personInitial(name: string): string {
  return name.trim().charAt(0) || '？'
}

/** 小圆头像：首字 + 标识色，宽高由 className 控制 */
export function AvatarChip({ personId, name, className = 'h-6 w-6 text-[11px]' }: { personId: string; name: string; className?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 select-none items-center justify-center rounded-full font-medium text-white ${className}`}
      style={{ backgroundColor: personColor(personId) }}
      title={name}
    >
      {personInitial(name)}
    </span>
  )
}
