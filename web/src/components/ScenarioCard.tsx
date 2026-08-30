import type { ForkScenario } from '../api/types'

function isoToLocalInput(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function localInputToIso(v: string): string {
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? v : d.toISOString()
}

interface ScenarioCardProps {
  scenario: ForkScenario
  onChange?: (s: ForkScenario) => void
  onConfirm?: () => void
  onCancel?: () => void
  confirming?: boolean
}

/** What-if 场景设定卡：起始时间/改变变量/参与人物/不变条件（F10），可编辑确认 */
export default function ScenarioCard({ scenario, onChange, onConfirm, onCancel, confirming }: ScenarioCardProps) {
  const editable = !!onChange
  const patch = (p: Partial<ForkScenario>) => onChange?.({ ...scenario, ...p })

  return (
    <div className="space-y-3 rounded-xl border border-woad/30 bg-woad-soft/60 p-4">
      <h3 className="text-sm font-medium text-woad-deep">分叉场景设定</h3>

      <div>
        <label className="mb-1 block text-xs text-woad-deep">What-if</label>
        {editable ? (
          <textarea
            className="w-full rounded-lg border border-woad/30 bg-sheet px-3 py-2 text-sm outline-none focus:border-woad"
            rows={2}
            value={scenario.whatIf}
            onChange={(e) => patch({ whatIf: e.target.value })}
          />
        ) : (
          <p className="text-sm text-ink">{scenario.whatIf}</p>
        )}
      </div>

      <div>
        <label className="mb-1 block text-xs text-woad-deep">起始时间</label>
        {editable ? (
          <input
            type="datetime-local"
            className="w-full rounded-lg border border-woad/30 bg-sheet px-3 py-2 text-sm outline-none focus:border-woad"
            value={isoToLocalInput(scenario.startTime)}
            onChange={(e) => patch({ startTime: localInputToIso(e.target.value) })}
          />
        ) : (
          <p className="text-sm text-ink">{scenario.startTime.slice(0, 16).replace('T', ' ')}</p>
        )}
      </div>

      <div>
        <label className="mb-1 block text-xs text-woad-deep">改变的变量</label>
        {editable ? (
          <textarea
            className="w-full rounded-lg border border-woad/30 bg-sheet px-3 py-2 text-sm outline-none focus:border-woad"
            rows={2}
            value={scenario.changedVariable}
            onChange={(e) => patch({ changedVariable: e.target.value })}
          />
        ) : (
          <p className="text-sm text-ink">{scenario.changedVariable}</p>
        )}
      </div>

      <div>
        <label className="mb-1 block text-xs text-woad-deep">参与人物（逗号分隔）</label>
        {editable ? (
          <input
            className="w-full rounded-lg border border-woad/30 bg-sheet px-3 py-2 text-sm outline-none focus:border-woad"
            value={scenario.participants.join('，')}
            onChange={(e) => patch({ participants: e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) })}
          />
        ) : (
          <p className="text-sm text-ink">{scenario.participants.join('、') || '无'}</p>
        )}
      </div>

      <div>
        <label className="mb-1 block text-xs text-woad-deep">保持不变的条件（每行一条）</label>
        {editable ? (
          <textarea
            className="w-full rounded-lg border border-woad/30 bg-sheet px-3 py-2 text-sm outline-none focus:border-woad"
            rows={3}
            value={scenario.invariants.join('\n')}
            onChange={(e) => patch({ invariants: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })}
          />
        ) : (
          <ul className="list-inside list-disc text-sm text-ink">
            {scenario.invariants.map((inv, i) => (
              <li key={i}>{inv}</li>
            ))}
          </ul>
        )}
      </div>

      {onConfirm && (
        <div className="flex gap-3 pt-1">
          <button
            onClick={onCancel}
            disabled={confirming}
            className="flex-1 rounded-xl border border-ink-faint bg-sheet py-2.5 text-ink-soft disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            disabled={confirming}
            className="flex-1 rounded-xl bg-woad-deep py-2.5 text-white disabled:opacity-50"
          >
            {confirming ? '正在创建分叉…' : '确认，让这条时间线开始'}
          </button>
        </div>
      )}
    </div>
  )
}
