import type { DistillDraft, ModelItem, PersonModel } from '../api/types'
import { fieldErrorId, type FieldErrors, type PersonCreateField } from '../lib/person-create-validation'

const LAYERS: { key: keyof Omit<PersonModel, 'unknowns'>; title: string }[] = [
  { key: 'identity', title: '身份与价值观' },
  { key: 'behavior', title: '行为模式' },
  { key: 'speech', title: '说话方式' },
  { key: 'skills', title: '技能与爱好' },
  { key: 'memories', title: '记忆' },
  { key: 'relationships', title: '关系' },
  { key: 'boundaries', title: '边界（TA 不会声称的事）' },
]

function Badge({ provenance, onClick }: { provenance: ModelItem['provenance']; onClick?: () => void }) {
  const known = provenance === 'known'
  return (
    <button
      type="button"
      onClick={onClick}
      title={onClick ? '点击切换 确知/推断' : undefined}
      className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
        known ? 'bg-emerald-100 text-emerald-700' : 'bg-cinnabar-soft text-cinnabar-deep'
      } ${onClick ? 'cursor-pointer' : 'cursor-default'}`}
    >
      {known ? '确知' : '推断'}
    </button>
  )
}

interface PersonCardProps {
  draft: DistillDraft
  onChange?: (d: DistillDraft) => void
  errors?: FieldErrors
  onFieldChange?: (field: PersonCreateField) => void
}

/** 人物卡：分层展示 + 确知/推断/未知三区标注；传 onChange 即可编辑（F4/F5） */
export default function PersonCard({ draft, onChange, errors = {}, onFieldChange }: PersonCardProps) {
  const editable = !!onChange
  const fieldError = (field: PersonCreateField) => errors[field]
  const errorProps = (field: PersonCreateField) => fieldError(field)
    ? { 'aria-describedby': fieldErrorId(field), 'aria-invalid': true as const }
    : { 'aria-invalid': false as const }
  const patch = (p: Partial<DistillDraft>) => onChange?.({ ...draft, ...p })
  const patchModel = (p: Partial<PersonModel>) => patch({ model: { ...draft.model, ...p } })

  const patchItem = (key: keyof Omit<PersonModel, 'unknowns'>, i: number, p: Partial<ModelItem>) => {
    const list = [...draft.model[key]]
    list[i] = { ...list[i], ...p }
    patchModel({ [key]: list } as Partial<PersonModel>)
  }
  const removeItem = (key: keyof Omit<PersonModel, 'unknowns'>, i: number) => {
    patchModel({ [key]: draft.model[key].filter((_, j) => j !== i) } as Partial<PersonModel>)
  }
  const addItem = (key: keyof Omit<PersonModel, 'unknowns'>) => {
    patchModel({ [key]: [...draft.model[key], { text: '', provenance: 'inferred' }] } as Partial<PersonModel>)
  }

  return (
    <div className="space-y-5">
      {/* 基本信息 */}
      <section className="rounded-xl border border-ink-line bg-sheet p-4">
        {editable ? (
          <div>
            <label htmlFor="person-create-name" className="mb-1 block text-xs text-ink-soft">姓名</label>
            <input
              id="person-create-name"
              className="w-full rounded-lg border border-ink-faint px-3 py-2 text-lg font-semibold outline-none focus:border-ink-soft"
              value={draft.name}
              {...errorProps('name')}
              onChange={(e) => { patch({ name: e.target.value }); onFieldChange?.('name') }}
            />
            {fieldError('name') && <p id={fieldErrorId('name')} role="alert" className="mt-1 text-sm text-red-600">{fieldError('name')}</p>}
          </div>
        ) : (
          <div>
            <h2 className="text-xl font-semibold text-ink">{draft.name}</h2>
          </div>
        )}
      </section>

      {/* 模型分层 */}
      {LAYERS.map(({ key, title }) => (
        <section key={key} className="rounded-xl border border-ink-line bg-sheet p-4">
          <h3 id={`person-create-${key}-label`} className="mb-2 text-sm font-medium text-ink-soft">{title}</h3>
          <ul className="space-y-2">
            {draft.model[key].map((item, i) => (
              <li key={i} className="flex items-start gap-2">
                <Badge
                  provenance={item.provenance}
                  onClick={
                    editable
                      ? () => patchItem(key, i, { provenance: item.provenance === 'known' ? 'inferred' : 'known' })
                      : undefined
                  }
                />
                {editable ? (
                  <>
                    <input
                      id={`person-create-${key}-${i}`}
                      className="min-w-0 flex-1 rounded-lg border border-ink-line px-2 py-1 text-sm outline-none focus:border-ink-soft"
                      value={item.text}
                      placeholder="补充一条…"
                      aria-labelledby={`person-create-${key}-label`}
                      {...errorProps(key as PersonCreateField)}
                      onChange={(e) => {
                        patchItem(key, i, { text: e.target.value })
                        if (key === 'identity' || key === 'behavior' || key === 'speech' || key === 'boundaries') onFieldChange?.(key)
                      }}
                    />
                    <button
                      type="button"
                      className="shrink-0 px-1 text-ink-faint hover:text-red-500"
                      onClick={() => removeItem(key, i)}
                      aria-label="删除"
                    >
                      ×
                    </button>
                  </>
                ) : (
                  <span className="text-sm text-ink-soft">{item.text}</span>
                )}
              </li>
            ))}
          </ul>
          {fieldError(key as PersonCreateField) && <p id={fieldErrorId(key as PersonCreateField)} role="alert" className="mt-2 text-sm text-red-600">{fieldError(key as PersonCreateField)}</p>}
          {editable && (
            <button
              type="button"
              className="mt-2 text-xs text-ink-soft underline"
              onClick={() => {
                addItem(key)
                if (key === 'identity' || key === 'behavior' || key === 'speech' || key === 'boundaries') onFieldChange?.(key)
              }}
            >
              + 添加一条
            </button>
          )}
        </section>
      ))}

      {/* 未知区 */}
      <section className="rounded-xl border border-dashed border-ink-faint bg-paper p-4">
        <h3 id="person-create-unknowns-label" className="mb-2 text-sm font-medium text-ink-soft">TA 还不知道的（被问到会坦然说不知道）</h3>
        <ul className="space-y-2">
          {draft.model.unknowns.map((u, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="shrink-0 rounded-full bg-paper-deep px-2 py-0.5 text-xs text-ink-soft">未知</span>
              {editable ? (
                <>
                  <input
                    id={`person-create-unknowns-${i}`}
                    className="min-w-0 flex-1 rounded-lg border border-ink-line bg-sheet px-2 py-1 text-sm outline-none focus:border-ink-soft"
                    value={u}
                    aria-labelledby="person-create-unknowns-label"
                    {...errorProps('unknowns')}
                    onChange={(e) => {
                      const unknowns = [...draft.model.unknowns]
                      unknowns[i] = e.target.value
                      patchModel({ unknowns })
                      onFieldChange?.('unknowns')
                    }}
                  />
                  <button
                    type="button"
                    className="shrink-0 px-1 text-ink-faint hover:text-red-500"
                    onClick={() => patchModel({ unknowns: draft.model.unknowns.filter((_, j) => j !== i) })}
                    aria-label="删除"
                  >
                    ×
                  </button>
                </>
              ) : (
                <span className="text-sm text-ink-soft">{u}</span>
              )}
            </li>
          ))}
        </ul>
        {fieldError('unknowns') && <p id={fieldErrorId('unknowns')} role="alert" className="mt-2 text-sm text-red-600">{fieldError('unknowns')}</p>}
        {editable && (
          <button
            type="button"
            className="mt-2 text-xs text-ink-soft underline"
            onClick={() => { patchModel({ unknowns: [...draft.model.unknowns, ''] }); onFieldChange?.('unknowns') }}
          >
            + 添加一条
          </button>
        )}
      </section>
    </div>
  )
}
