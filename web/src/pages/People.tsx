import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiFetch } from '../api/client'
import type { PersonListItem } from '../api/types'

export default function People() {
  const [persons, setPersons] = useState<PersonListItem[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    apiFetch<{ persons: PersonListItem[] }>('/api/persons')
      .then((res) => setPersons(res.persons))
      .catch(() => setError('加载失败'))
  }, [])

  if (error) return <div className="p-8 text-center text-sm text-red-600">{error}</div>
  if (!persons) return <div className="p-8 text-center text-sm text-ink-faint">加载中…</div>

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-ink">人物</h1>
        <Link to="/people/new" className="rounded-xl bg-ink px-4 py-2 text-sm text-white">
          ＋ 创建人物
        </Link>
      </div>

      {persons.length === 0 ? (
        <p className="rounded-xl border border-dashed border-ink-faint bg-sheet p-8 text-center text-sm text-ink-faint">
          还没有人物。每一个 Version，都是一种可能性。
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {persons.map((p) => (
            <Link
              key={p.id}
              to={`/people/${p.id}`}
              className="rounded-xl border border-ink-line bg-sheet p-4 hover:border-ink-faint"
            >
              <p className="font-medium text-ink">{p.name}</p>
              <p className="mt-1 text-xs text-ink-faint">创建于 {p.createdAt.slice(0, 10)}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
