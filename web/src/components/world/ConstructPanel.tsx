import { useState } from 'react'
import { worldsApi } from '../../api/client'
import type { LocationDef } from '../../api/types'
import InjectBox from './InjectBox'

interface Props { worldId: string; timelineId: string; locations: LocationDef[]; onInject: (text: string, requestId: string) => Promise<void>; onChanged: () => void }

export default function ConstructPanel({ worldId, timelineId, locations, onInject, onChanged }: Props) {
  const [location, setLocation] = useState('')
  const [condition, setCondition] = useState('')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const submit = async () => {
    if (!condition.trim() || !value.trim() || busy) return
    setBusy(true); setMessage('')
    try {
      const state = await worldsApi.state(worldId, timelineId)
      const result = await worldsApi.command(worldId, { id: crypto.randomUUID(), timelineId, expectedVersion: state.version,
        action: { type: 'environment', location: location || null, condition: condition.trim(), value: value.trim() } })
      setMessage(`条件已写入当前宇宙，事实版本 v${result.version}。`)
      setValue('')
      onChanged()
    } catch (e) { setMessage(e instanceof Error ? e.message : '改变条件失败') }
    finally { setBusy(false) }
  }
  return <section className="space-y-3 rounded-xl border border-ink-line bg-sheet p-4">
    <div><h2 className="font-story text-base text-ink">构造条件</h2><p className="mt-1 text-xs text-ink-faint">只改变当前宇宙的一个环境条件，不代替居民选择。</p></div>
    <div className="flex flex-wrap gap-2">
      <select aria-label="作用地点" value={location} onChange={e => setLocation(e.target.value)} className="rounded-lg border border-ink-line bg-paper px-2 py-1.5 text-xs"><option value="">全世界</option>{locations.map(l => <option key={l.name} value={l.name}>{l.name}</option>)}</select>
      <input aria-label="条件" value={condition} onChange={e => setCondition(e.target.value)} placeholder="条件，例如天气" maxLength={40} className="min-w-0 flex-1 rounded-lg border border-ink-line bg-paper px-2 py-1.5 text-xs" />
      <input aria-label="值" value={value} onChange={e => setValue(e.target.value)} placeholder="新状态，例如暴雨" maxLength={200} className="min-w-0 flex-1 rounded-lg border border-ink-line bg-paper px-2 py-1.5 text-xs" />
      <button onClick={() => void submit()} disabled={busy || !condition.trim() || !value.trim()} className="rounded-lg bg-ink px-3 py-1.5 text-xs text-white disabled:opacity-50">{busy ? '提交中…' : '应用条件'}</button>
    </div>
    {message && <p className="text-xs text-ink-soft">{message}</p>}
    <div className="border-t border-ink-line pt-3"><p className="mb-2 text-xs text-ink-faint">叙事干预会写入当前宇宙历史，并由居民在后续生活中自行感知和回应；它不等同于直接改变环境事实。</p><InjectBox onInject={async (text, requestId) => { await onInject(text, requestId); onChanged() }} /></div>
  </section>
}
