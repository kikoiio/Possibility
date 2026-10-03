import { useEffect, useMemo, useRef, useState } from 'react'
import { worldsApi } from '../../api/client'
import { effectiveTimeZone } from '../../lib/world-time'

interface Props {
  worldId: string
  timeZone?: string | null
  onSaved: (timeZone: string) => void
}

export default function WorldTimeZoneSetting({ worldId, timeZone, onSaved }: Props) {
  const applied = effectiveTimeZone(timeZone)
  const [draft, setDraft] = useState(applied)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const saving = useRef(false)
  useEffect(() => { setDraft(applied) }, [worldId, applied])
  const zones = useMemo(() => {
    let supported: string[] = []
    try { supported = Intl.supportedValuesOf?.('timeZone') ?? [] } catch { /* Older browsers retain common choices. */ }
    return [...new Set(['UTC', applied, 'Asia/Shanghai', 'Asia/Tokyo', 'America/New_York', 'Europe/London', ...supported])].sort()
  }, [applied])
  async function save() {
    if (saving.current || draft === applied) return
    saving.current = true
    setBusy(true); setMessage('')
    try {
      const result = await worldsApi.updateTimeZone(worldId, draft)
      onSaved(result.timeZone)
      setMessage('世界时区已更新。')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败；当前生效时区未更改，可重试。')
    } finally { saving.current = false; setBusy(false) }
  }
  return <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="world-time-zone-setting">
    <label className="flex min-w-0 items-center gap-2">世界时区
      <select aria-label="世界时区" value={draft} onChange={event => { setDraft(event.target.value); setMessage('') }} disabled={busy}
        className="min-w-0 max-w-52 rounded-lg border border-ink-line bg-white px-2 py-1.5 text-ink">
        {zones.map(zone => <option key={zone} value={zone}>{zone}</option>)}
      </select>
    </label>
    <button type="button" onClick={() => void save()} disabled={busy || draft === applied} className="rounded-lg border border-ink-line px-3 py-1.5 disabled:opacity-45">{busy ? '保存中…' : '保存时区'}</button>
    <span className="w-full text-ink-faint">当前生效：{applied}</span>
    {message && <span role="status" className="w-full">{message}</span>}
  </div>
}
