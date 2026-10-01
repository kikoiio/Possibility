import { useEffect, useState, type FormEvent } from 'react'
import { ApiError, worldLlmConfigApi, type WorldLlmConfig } from '../api/client'

/** 世界级 BYOK 覆盖(F6):逐字段覆盖全局配置;空字段 = 跟随全局。Key 只写不读。 */
export default function WorldLlmConfigPanel({ worldId }: { worldId: string }) {
  const [config, setConfig] = useState<WorldLlmConfig | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    worldLlmConfigApi.get(worldId).then((data) => {
      setConfig(data)
      setBaseUrl(data.baseUrl ?? '')
      setModel(data.model ?? '')
    }).catch(() => setMsg('覆盖配置读取失败'))
  }, [worldId])

  async function save(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setMsg('')
    try {
      const patch: { baseUrl?: string; model?: string; apiKey?: string } = {}
      if (baseUrl.trim()) patch.baseUrl = baseUrl.trim()
      if (model.trim()) patch.model = model.trim()
      if (apiKey.trim()) patch.apiKey = apiKey.trim()
      const next = await worldLlmConfigApi.put(worldId, Object.keys(patch).length ? patch : null)
      setConfig(next)
      setApiKey('')
      setMsg(Object.keys(patch).length ? '已保存;未填字段跟随全局配置' : '已清除覆盖,跟随全局配置')
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : '保存失败,请重试')
    } finally {
      setBusy(false)
    }
  }

  async function clear() {
    if (busy) return
    setBusy(true)
    setMsg('')
    try {
      const next = await worldLlmConfigApi.put(worldId, null)
      setConfig(next)
      setBaseUrl('')
      setModel('')
      setApiKey('')
      setMsg('已清除覆盖,跟随全局配置')
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : '清除失败,请重试')
    } finally {
      setBusy(false)
    }
  }

  const inputCls = 'w-full rounded-lg border border-ink-faint px-2.5 py-1.5 text-xs outline-none focus:border-ink-soft'

  return (
    <form onSubmit={save} className="mt-1.5 space-y-2 rounded-lg border border-ink-line bg-paper px-3 py-2.5"
      data-testid="world-llm-config">
      <p className="text-xs text-ink-soft">
        世界 LLM 覆盖:只对本世界生效,未填字段跟随全局(设置页)。
        {config?.hasKey ? ` 当前 Key:${config.keyPreview}` : ''}
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        <input className={inputCls} placeholder="baseUrl(跟随全局)" value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)} data-testid="world-llm-baseurl" />
        <input className={inputCls} placeholder="模型(跟随全局)" value={model}
          onChange={(e) => setModel(e.target.value)} data-testid="world-llm-model" />
        <input className={inputCls} type="password" placeholder={config?.hasKey ? `Key ${config.keyPreview}` : 'API Key(跟随全局)'}
          value={apiKey} onChange={(e) => setApiKey(e.target.value)} data-testid="world-llm-apikey" />
      </div>
      {msg && <p className="text-xs text-ink-soft" data-testid="world-llm-msg">{msg}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy}
          className="rounded-lg bg-ink px-3 py-1.5 text-xs text-white disabled:opacity-50" data-testid="world-llm-save">保存覆盖</button>
        <button type="button" onClick={clear} disabled={busy}
          className="rounded-lg border border-ink-faint px-3 py-1.5 text-xs text-ink-soft disabled:opacity-50"
          data-testid="world-llm-clear">清除覆盖</button>
      </div>
    </form>
  )
}
