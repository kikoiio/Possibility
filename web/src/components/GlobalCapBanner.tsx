import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { settingsApi, type BudgetSettings } from '../api/client'

/** 全局预算触顶横幅(F10):出现即说明有世界因 global_daily_cap 暂停;提额即恢复。 */
export default function GlobalCapBanner() {
  const [budget, setBudget] = useState<BudgetSettings | null>(null)

  useEffect(() => {
    settingsApi.getBudget().then(setBudget).catch(() => setBudget(null))
  }, [])

  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3"
      data-testid="global-cap-banner" role="alert">
      <p className="text-sm text-amber-900">
        今日全局 LLM 预算已用尽
        {budget ? `(${budget.usedToday}/${budget.dailyCallCap ?? '不限'} 次调用)` : ''}
        ,运行中的世界已暂停。提高预算或设为不限即可恢复。
      </p>
      <Link to="/settings"
        className="shrink-0 rounded-xl bg-amber-600 px-3 py-1.5 text-sm text-white hover:bg-amber-700"
        data-testid="global-cap-cta">
        提高预算
      </Link>
    </div>
  )
}
