import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ApiError, settingsApi, type BudgetSettings, type LlmSettings } from '../api/client'

/** S4 提供方预设:选中填 baseUrl+建议模型,不碰 Key;自定义 = 手填 */
const PROVIDER_PRESETS = [
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' },
  { id: 'custom', label: '自定义', baseUrl: '', model: '' },
] as const
type PresetId = (typeof PROVIDER_PRESETS)[number]['id']

function presetOf(baseUrl: string): PresetId {
  const hit = PROVIDER_PRESETS.find(p => p.id !== 'custom' && p.baseUrl === baseUrl.trim())
  return hit?.id ?? 'custom'
}

const CUSTOM_PRESET_KEY = 'possibility:llm-custom:v1'
type CustomFields = { baseUrl: string; model: string }
function readCustomFields(): CustomFields {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(CUSTOM_PRESET_KEY) ?? 'null')
    if (value && typeof value === 'object' && 'baseUrl' in value && 'model' in value
      && typeof value.baseUrl === 'string' && typeof value.model === 'string') {
      return { baseUrl: value.baseUrl, model: value.model }
    }
  } catch { /* Persistence is optional. */ }
  return { baseUrl: '', model: '' }
}

/** 设置页(F5/S3):全局 BYOK LLM 配置 + 全局日预算。Key 只写不读,掩码回显。 */
export default function SettingsPage() {
  const [llm, setLlm] = useState<LlmSettings | null>(null)
  const [budget, setBudget] = useState<BudgetSettings | null>(null)
  const [preset, setPreset] = useState<PresetId>('custom')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [cap, setCap] = useState('')
  const [unlimited, setUnlimited] = useState(false)
  const [llmMsg, setLlmMsg] = useState('')
  const [budgetMsg, setBudgetMsg] = useState('')
  const [busy, setBusy] = useState(false)
  // 用户已动手(预设/输入)后,迟到的 getLlm 回填不得覆盖
  const touched = useRef(false)
  const modelTouched = useRef(false)
  const customFields = useRef<CustomFields>({ baseUrl: '', model: '' })
  const busyRef = useRef(false)

  function rememberCustom() {
    if (preset !== 'custom') return
    customFields.current = { baseUrl: baseUrl.trim(), model: model.trim() }
    try { localStorage.setItem(CUSTOM_PRESET_KEY, JSON.stringify(customFields.current)) } catch { /* Optional. */ }
  }

  async function refreshBudget() {
    const data = await settingsApi.getBudget()
    setBudget(data)
    setUnlimited(data.dailyCallCap === null)
    setCap(data.dailyCallCap === null ? '' : String(data.dailyCallCap))
  }

  useEffect(() => {
    customFields.current = readCustomFields()
    settingsApi.getLlm().then((data) => {
      setLlm(data)
      if (touched.current) return
      setBaseUrl(data.baseUrl ?? '')
      setModel(data.model ?? '')
      const loadedPreset = presetOf(data.baseUrl ?? '')
      setPreset(loadedPreset)
      modelTouched.current = loadedPreset === 'custom' && Boolean(data.model?.trim())
      if (loadedPreset === 'custom') customFields.current = { baseUrl: data.baseUrl ?? '', model: data.model ?? '' }
    }).catch(() => setLlmMsg('配置读取失败'))
    settingsApi.getBudget().then((data) => {
      setBudget(data)
      setUnlimited(data.dailyCallCap === null)
      setCap(data.dailyCallCap === null ? '' : String(data.dailyCallCap))
    }).catch(() => setBudgetMsg('预算读取失败'))
  }, [])

  async function saveLlm(e: FormEvent) {
    e.preventDefault()
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setLlmMsg('')
    try {
      const patch: { baseUrl: string | null; model: string | null; apiKey?: string } = {
        baseUrl: baseUrl.trim() || null,
        model: model.trim() || null,
      }
      if (apiKey.trim()) patch.apiKey = apiKey.trim()
      const next = await settingsApi.putLlm(patch)
      setLlm(next)
      setApiKey('')
      rememberCustom()
      setLlmMsg(next.verification?.status === 'verified' ? '已保存，连接可用' : '已保存但未验证')
      await refreshBudget()
    } catch (err) {
      setLlmMsg(err instanceof ApiError ? err.message : '保存失败,请重试')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  async function testLlm() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setLlmMsg('')
    try {
      const patch: { baseUrl: string | null; model: string | null; apiKey?: string } = {
        baseUrl: baseUrl.trim() || null,
        model: model.trim() || null,
      }
      if (apiKey.trim()) patch.apiKey = apiKey.trim()
      const saved = await settingsApi.putLlm(patch)
      setLlm(saved)
      rememberCustom()
      setApiKey('')
      setLlmMsg('配置已保存，正在测试…')
      const result = await settingsApi.testLlm()
      setLlm({ ...saved, verification: { status: 'verified', verifiedAt: result.verifiedAt } })
      setLlmMsg('连接成功，配置已验证')
      await refreshBudget()
    } catch (err) {
      const current = await settingsApi.getLlm().catch(() => null)
      if (current) setLlm(current)
      await refreshBudget().catch(() => {})
      setLlmMsg(err instanceof ApiError ? err.message : '连接测试失败，请检查配置后重试')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  async function clearLlm() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setLlmMsg('')
    try {
      await settingsApi.deleteLlm()
      setLlm({ baseUrl: null, model: null, hasKey: false, keyPreview: null,
        verification: { status: 'incomplete', verifiedAt: null } })
      setBaseUrl('')
      setModel('')
      setApiKey('')
      customFields.current = { baseUrl: '', model: '' }
      try { localStorage.removeItem(CUSTOM_PRESET_KEY) } catch { /* Optional. */ }
      setPreset('custom')
      modelTouched.current = false
      await refreshBudget()
      setLlmMsg('已删除,LLM 调用回落平台配置；世界覆盖仍优先，个人豁免已失效')
    } catch (err) {
      setLlmMsg(err instanceof ApiError ? err.message : '删除失败,请重试')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  async function saveBudget(e: FormEvent) {
    e.preventDefault()
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setBudgetMsg('')
    try {
      const value = unlimited ? null : Number.parseInt(cap, 10)
      if (!unlimited && (!Number.isSafeInteger(value) || (value as number) <= 0)) {
        setBudgetMsg('预算须为正整数')
        return
      }
      const next = await settingsApi.putBudget(value)
      setBudget(next)
      setBudgetMsg(next.dailyCallCap === null || next.usedToday < next.dailyCallCap
        ? '已保存；被全局预算暂停的世界已恢复' : '已保存，当前用量仍已达到日预算')
    } catch (err) {
      setBudgetMsg(err instanceof ApiError ? err.message : '保存失败,请重试')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const inputCls = 'w-full rounded-xl border border-ink-faint px-3 py-2 text-sm outline-none focus:border-ink-soft'

  function applyPreset(next: PresetId) {
    touched.current = true
    if (preset === 'custom') customFields.current = { baseUrl, model }
    setPreset(next)
    const found = PROVIDER_PRESETS.find(p => p.id === next)
    if (!found) return
    if (next === 'custom') {
      setBaseUrl(customFields.current.baseUrl)
      setModel(customFields.current.model)
      modelTouched.current = Boolean(customFields.current.model.trim())
    } else {
      setBaseUrl(found.baseUrl)
      if (!modelTouched.current) setModel(found.model)
    }
  }

  const normalizeEndpoint = (value: string | null | undefined) => (value ?? '').trim().replace(/\/+$/, '')
  const changed = normalizeEndpoint(baseUrl) !== normalizeEndpoint(llm?.baseUrl)
    || model.trim() !== (llm?.model ?? '').trim() || Boolean(apiKey.trim())
  const verification = !baseUrl.trim() || !model.trim() || !apiKey.trim() && !llm?.hasKey
    ? 'incomplete' : changed ? 'unverified' : llm?.verification?.status ?? 'unverified'

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-6">
      <div>
        <h1 className="mb-1 text-xl font-semibold text-ink">设置</h1>
        <p className="text-sm text-ink-soft">自己的模型 Key 与日预算;世界寿命不设限,烧谁的 Key 由你定。</p>
      </div>

      <section className="space-y-3 rounded-2xl border border-ink-faint p-4" data-testid="llm-settings">
        <h2 className="text-base font-medium text-ink">LLM 配置(BYOK)</h2>
        <p className="text-xs text-ink-faint">世界覆盖优先，其余调用使用已填写的个人配置字段；未填写字段使用平台兜底。未验证配置仍可能被调用，请先测试连接。</p>
        {llm?.hasKey && <p className="text-xs text-ink-soft">当前 Key:{llm.keyPreview}(仅显示末 4 位;输入新 Key 即替换)</p>}
        {llm && <p className="text-xs text-ink-soft" data-testid="llm-verification">
          {verification === 'verified' ? `已验证 · ${llm.verification?.verifiedAt ?? ''}`
            : verification === 'unverified' ? changed ? '配置已修改，保存后须重新测试' : '已保存，尚未验证' : '个人配置不完整，未验证'}
        </p>}
        <form onSubmit={saveLlm} className="space-y-3">
          <div className="text-sm text-ink-soft">提供方
            <div className="mt-1.5 flex gap-2" data-testid="llm-preset">
              {PROVIDER_PRESETS.map(p => (
                <button key={p.id} type="button" onClick={() => applyPreset(p.id)} aria-pressed={preset === p.id}
                  className={`rounded-full border px-3.5 py-1.5 text-xs ${preset === p.id ? 'border-ink bg-ink text-white' : 'border-ink-faint text-ink-soft'}`}
                  data-testid={`llm-preset-${p.id}`}>{p.label}</button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-ink-faint">须 OpenAI 兼容协议（/chat/completions）;Anthropic 等不兼容的提供方需经兼容代理。</p>
          </div>
          <label className="block text-sm text-ink-soft">端点 baseUrl(OpenAI 兼容)
            <input className={inputCls} placeholder="https://api.example.com/v1" value={baseUrl}
              onChange={(e) => { touched.current = true; setBaseUrl(e.target.value); setPreset('custom') }} data-testid="llm-baseurl" />
          </label>
          <label className="block text-sm text-ink-soft">模型
            <input className={inputCls} placeholder="例如 deepseek-chat / gpt-5" value={model}
              onChange={(e) => { touched.current = true; modelTouched.current = true; setModel(e.target.value) }} data-testid="llm-model" />
          </label>
          <label className="block text-sm text-ink-soft">API Key
            <input className={inputCls} type="password" placeholder={llm?.hasKey ? `当前 ${llm.keyPreview}` : 'sk-…'}
              value={apiKey} onChange={(e) => setApiKey(e.target.value)} data-testid="llm-apikey" />
          </label>
          <p className="text-xs text-ink-faint">连接测试会向提供方发送一次最小请求，可能产生费用。</p>
        {llmMsg && <p className="text-sm text-ink-soft" data-testid="llm-msg">{llmMsg}</p>}
          <div className="flex gap-3">
            <button type="submit" disabled={busy}
              className="rounded-xl bg-ink px-4 py-2 text-sm text-white disabled:opacity-50" data-testid="llm-save">保存草稿</button>
            <button type="button" onClick={testLlm} disabled={busy || !baseUrl.trim() || !model.trim() || !apiKey.trim() && !llm?.hasKey}
              className="rounded-xl border border-ink-faint px-4 py-2 text-sm text-ink-soft disabled:opacity-50" data-testid="llm-test">保存并测试</button>
            <button type="button" onClick={clearLlm} disabled={busy || !llm?.hasKey && !llm?.baseUrl && !llm?.model}
              className="rounded-xl border border-ink-faint px-4 py-2 text-sm text-ink-soft disabled:opacity-50"
              data-testid="llm-delete">删除配置</button>
          </div>
        </form>
      </section>

      <section className="space-y-3 rounded-2xl border border-ink-faint p-4" data-testid="budget-settings">
        <h2 className="text-base font-medium text-ink">日预算</h2>
        <p className="text-xs text-ink-faint">有限预算时所有来源共享上限；不限时仅已验证的个人全局 Key 豁免，世界覆盖 Key 与平台兜底共用每日 400 次。</p>
        {budget && (
          <p className="text-xs text-ink-soft" data-testid="budget-usage">
            {budget.dailyCallCap === null
              ? `今日总调用 ${budget.usedToday} 次；回退来源已用 ${budget.fallbackUsedToday ?? 0} / 400 次`
              : `今日已用 ${budget.usedToday} / ${budget.dailyCallCap} 次调用(全部世界共享)`}
          </p>
        )}
        {budget?.dailyCallCap === null && verification !== 'verified' && <p className="text-xs text-ink-soft" data-testid="budget-fallback">
          个人配置尚未验证，当前没有个人 Key 不限豁免；调用受每日 400 次回退额度限制。删除配置后日预算恢复默认 400 次。
        </p>}
        <form onSubmit={saveBudget} className="space-y-3">
          <label className="flex items-center gap-2 text-sm text-ink-soft">
            <input type="checkbox" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)}
              data-testid="budget-unlimited" />
            不限(仅已验证个人 Key 豁免)
          </label>
          {!unlimited && (
            <label className="block text-sm text-ink-soft">每日调用上限
              <input className={inputCls} type="number" min={1} value={cap}
                onChange={(e) => setCap(e.target.value)} data-testid="budget-cap" />
            </label>
          )}
          {budgetMsg && <p className="text-sm text-ink-soft" data-testid="budget-msg">{budgetMsg}</p>}
          <button type="submit" disabled={busy}
            className="rounded-xl bg-ink px-4 py-2 text-sm text-white disabled:opacity-50" data-testid="budget-save">保存预算</button>
        </form>
      </section>
    </div>
  )
}
