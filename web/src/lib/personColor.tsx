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
]

export function personColor(personId: string): string {
  let h = 0
  for (let i = 0; i < personId.length; i++) h = (h * 31 + personId.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
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
