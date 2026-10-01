import { useEffect, useState, type FormEvent } from 'react'
import { ApiError, settingsApi, type BudgetSettings, type LlmSettings } from '../api/client'

/** 设置页(F5/S3):全局 BYOK LLM 配置 + 全局日预算。Key 只写不读,掩码回显。 */
export default function SettingsPage() {
  const [llm, setLlm] = useState<LlmSettings | null>(null)
  const [budget, setBudget] = useState<BudgetSettings | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [cap, setCap] = useState('')
  const [unlimited, setUnlimited] = useState(false)
  const [llmMsg, setLlmMsg] = useState('')
  const [budgetMsg, setBudgetMsg] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    settingsApi.getLlm().then((data) => {
      setLlm(data)
      setBaseUrl(data.baseUrl ?? '')
      setModel(data.model ?? '')
    }).catch(() => setLlmMsg('配置读取失败'))
    settingsApi.getBudget().then((data) => {
      setBudget(data)
      setUnlimited(data.dailyCallCap === null)
      setCap(data.dailyCallCap === null ? '' : String(data.dailyCallCap))
    }).catch(() => setBudgetMsg('预算读取失败'))
  }, [])

  async function saveLlm(e: FormEvent) {
    e.preventDefault()
    if (busy) return
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
      setLlmMsg('已保存')
    } catch (err) {
      setLlmMsg(err instanceof ApiError ? err.message : '保存失败,请重试')
    } finally {
      setBusy(false)
    }
  }

  async function clearLlm() {
    if (busy) return
    setBusy(true)
    setLlmMsg('')
    try {
      await settingsApi.deleteLlm()
      setLlm({ baseUrl: null, model: null, hasKey: false, keyPreview: null })
      setBaseUrl('')
      setModel('')
      setApiKey('')
      setLlmMsg('已删除,LLM 调用回落平台配置')
    } catch (err) {
      setLlmMsg(err instanceof ApiError ? err.message : '删除失败,请重试')
    } finally {
      setBusy(false)
    }
  }

  async function saveBudget(e: FormEvent) {
    e.preventDefault()
    if (busy) return
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
      setBudgetMsg('已保存;被全局预算暂停的世界已恢复')
    } catch (err) {
      setBudgetMsg(err instanceof ApiError ? err.message : '保存失败,请重试')
    } finally {
      setBusy(false)
    }
  }

  const inputCls = 'w-full rounded-xl border border-ink-faint px-3 py-2 text-sm outline-none focus:border-ink-soft'

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-6">
      <div>
        <h1 className="mb-1 text-xl font-semibold text-ink">设置</h1>
        <p className="text-sm text-ink-soft">自己的模型 Key 与日预算;世界寿命不设限,烧谁的 Key 由你定。</p>
      </div>

      <section className="space-y-3 rounded-2xl border border-ink-faint p-4" data-testid="llm-settings">
        <h2 className="text-base font-medium text-ink">LLM 配置(BYOK)</h2>
        <p className="text-xs text-ink-faint">配置后,全部 LLM 调用(世界推进、对话、分叉)都走你的 Key;留空则回落平台兜底。</p>
        {llm?.hasKey && <p className="text-xs text-ink-soft">当前 Key:{llm.keyPreview}(仅显示末 4 位;输入新 Key 即替换)</p>}
        <form onSubmit={saveLlm} className="space-y-3">
          <label className="block text-sm text-ink-soft">端点 baseUrl(OpenAI 兼容)
            <input className={inputCls} placeholder="https://api.example.com/v1" value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)} data-testid="llm-baseurl" />
          </label>
          <label className="block text-sm text-ink-soft">模型
            <input className={inputCls} placeholder="例如 claude-sonnet-4-5 / gpt-5" value={model}
              onChange={(e) => setModel(e.target.value)} data-testid="llm-model" />
          </label>
          <label className="block text-sm text-ink-soft">API Key
            <input className={inputCls} type="password" placeholder={llm?.hasKey ? `当前 ${llm.keyPreview}` : 'sk-…'}
              value={apiKey} onChange={(e) => setApiKey(e.target.value)} data-testid="llm-apikey" />
          </label>
          {llmMsg && <p className="text-sm text-ink-soft" data-testid="llm-msg">{llmMsg}</p>}
          <div className="flex gap-3">
            <button type="submit" disabled={busy}
              className="rounded-xl bg-ink px-4 py-2 text-sm text-white disabled:opacity-50" data-testid="llm-save">保存</button>
            <button type="button" onClick={clearLlm} disabled={busy || !llm?.hasKey && !llm?.baseUrl && !llm?.model}
              className="rounded-xl border border-ink-faint px-4 py-2 text-sm text-ink-soft disabled:opacity-50"
              data-testid="llm-delete">删除配置</button>
          </div>
        </form>
      </section>

      <section className="space-y-3 rounded-2xl border border-ink-faint p-4" data-testid="budget-settings">
        <h2 className="text-base font-medium text-ink">日预算</h2>
        {budget && (
          <p className="text-xs text-ink-soft" data-testid="budget-usage">
            今日已用 {budget.usedToday} / {budget.dailyCallCap === null ? '不限' : budget.dailyCallCap} 次调用(全部世界共享)
          </p>
        )}
        <form onSubmit={saveBudget} className="space-y-3">
          <label className="flex items-center gap-2 text-sm text-ink-soft">
            <input type="checkbox" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)}
              data-testid="budget-unlimited" />
            不限(自己 Key 的世界可长期运行)
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
