/** 新建分支的可读字段；历史 scenario 的读取仍允许缺少 name。 */
export function normalizeForkFields(record: Record<string, unknown>): { name: string; whatIf: string; changedVariable: string } | null {
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  const whatIf = typeof record.whatIf === 'string' ? record.whatIf.trim() : ''
  const changedVariable = typeof record.changedVariable === 'string' ? record.changedVariable.trim() : ''
  if (!name || name.length > 80 || !whatIf || whatIf.length > 500 || !changedVariable || changedVariable.length > 200) return null
  return { name, whatIf, changedVariable }
}
