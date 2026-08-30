import type { LocationBoardEntry } from '../../api/types'
import { AvatarChip } from '../../lib/personColor'

interface PersonLiveState {
  simTime: string
  location: string
  activity: string
  mood: string
  goal: string
  currentDialogueId: string | null
}

interface Props {
  locationBoard: LocationBoardEntry[]
  liveStates: Record<string, PersonLiveState>
  onSelectPerson: (personId: string) => void
}

/** 地点面板：每个地点的在场人物与活动（状态随流实时更新），交谈中带脉动指示 */
export default function LocationPanel({ locationBoard, liveStates, onSelectPerson }: Props) {
  // 按 liveStates 重排：优先用实时地点
  const byLocation = new Map<string, { id: string; name: string; activity: string }[]>()
  for (const entry of locationBoard) byLocation.set(entry.location, [...entry.persons])
  for (const [pid, st] of Object.entries(liveStates)) {
    for (const persons of byLocation.values()) {
      const i = persons.findIndex((p) => p.id === pid)
      if (i >= 0) persons.splice(i, 1)
    }
    const name = locationBoard.flatMap((l) => l.persons).find((p) => p.id === pid)?.name ?? ''
    if (!name) continue
    const list = byLocation.get(st.location) ?? []
    list.push({ id: pid, name, activity: st.activity })
    byLocation.set(st.location, list)
  }

  const locations = locationBoard.map((l) => l.location)
  for (const loc of byLocation.keys()) if (!locations.includes(loc)) locations.push(loc)

  return (
    <div className="space-y-2">
      <h2 className="px-1 font-story text-sm font-semibold tracking-widest text-ink-soft">地点</h2>
      {locations.map((loc) => {
        const persons = byLocation.get(loc) ?? []
        return (
          <div key={loc} className="rounded-xl border border-ink-line bg-sheet p-2.5">
            <div className="flex items-center justify-between">
              <p className="font-story text-xs font-semibold text-ink-soft">{loc}</p>
              <span className="text-[10px] text-ink-faint">{persons.length > 0 ? `${persons.length} 人` : ''}</span>
            </div>
            {persons.length === 0 ? (
              <p className="mt-1 text-xs text-ink-faint/70">静</p>
            ) : (
              <ul className="mt-1.5 space-y-1.5">
                {persons.map((p) => {
                  const inDialogue = !!liveStates[p.id]?.currentDialogueId
                  return (
                    <li key={p.id}>
                      <button
                        onClick={() => onSelectPerson(p.id)}
                        className="flex w-full items-center gap-2 rounded-lg px-1 py-0.5 text-left transition-colors hover:bg-paper-deep/60"
                      >
                        <AvatarChip personId={p.id} name={p.name} className="h-5 w-5 text-[10px]" />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1 text-xs font-medium text-ink">
                            {p.name}
                            {inDialogue && (
                              <span className="inline-block h-1.5 w-1.5 animate-pulse-soft rounded-full bg-woad" title="正在交谈" />
                            )}
                          </span>
                          <span className="block truncate text-[11px] text-ink-faint" title={p.activity}>
                            {p.activity}
                          </span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}
