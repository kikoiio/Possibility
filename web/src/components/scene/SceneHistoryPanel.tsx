export interface SceneRevisionItem {
  revisionId: string
  version: number
  parentRevisionId: string | null
  origin: 'current' | 'ancestor'
  originTimelineId: string
  summary: string
  kind: string
  createdAt: string
}

export type SceneHistoryViewState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; revisions: SceneRevisionItem[]; currentVersion: number; currentRevisionId: string | null }

export function SceneHistoryPanel({ state, restoring, readOnly, restoreError, onRestore, onRetry, onClose }: {
  state: SceneHistoryViewState
  restoring: boolean
  readOnly: boolean
  restoreError: string
  onRestore: (revision: SceneRevisionItem) => void
  onRetry: () => void
  onClose: () => void
}) {
  return <div className="fixed inset-0 z-40 grid place-items-center bg-[#26382c]/25 p-4" onClick={onClose}>
    <section role="dialog" aria-modal="true" aria-label="场景历史" className="max-h-[75vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-[#dfe4d9] bg-[#fffefa] p-5 shadow-xl" onClick={event => event.stopPropagation()}>
      <header className="flex items-center justify-between">
        <h2 className="font-story text-lg text-[#31483a]">场景历史</h2>
        <button type="button" aria-label="关闭历史" onClick={onClose} className="rounded-full px-3 py-1 text-[#748176]">关闭</button>
      </header>
      {state.status === 'loading' && <p role="status" aria-live="polite" className="py-8 text-center text-sm text-[#798579]">正在读取场景历史…</p>}
      {state.status === 'error' && <div className="py-6 text-center" role="alert">
        <p className="text-sm text-[#8a5147]">{state.message}</p>
        <button type="button" onClick={onRetry} className="mt-3 rounded-full border border-[#d7b7ad] px-4 py-2 text-xs text-[#80564e]">重试读取历史</button>
      </div>}
      {state.status === 'ready' && <>
        {readOnly && <p role="status" className="mt-3 rounded-lg bg-paper-deep px-3 py-2 text-sm text-ink-soft">此时间线只读；可以查看场景历史。</p>}
        {restoreError && <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">恢复失败：{restoreError}</p>}
        {!state.revisions.length
          ? <p className="py-8 text-center text-sm text-[#798579]">还没有已保存版本。</p>
          : <ol className="mt-3 space-y-2">{state.revisions.map(revision => <li key={revision.revisionId} className="flex items-center justify-between gap-3 rounded-xl border border-[#e4e8df] bg-white px-3 py-3">
            <div>
              <p className="text-sm font-medium text-[#3f5646]">v{revision.version} · {revision.summary}{revision.revisionId === state.currentRevisionId ? ' · 当前版本' : ''}</p>
              <p className="mt-1 text-[11px] text-[#859085]">{revision.kind} · {revision.origin === 'ancestor' ? `祖先时间线 ${revision.originTimelineId}` : '当前时间线'} · {new Date(revision.createdAt).toLocaleString('zh-CN')}</p>
            </div>
            {revision.revisionId !== state.currentRevisionId && <button type="button" disabled={restoring || readOnly} onClick={() => onRestore(revision)} className="shrink-0 rounded-full border border-[#d4ded3] px-3 py-1.5 text-xs text-[#496153] disabled:opacity-40">{restoring ? '恢复中…' : '恢复到此版本'}</button>}
          </li>)}</ol>}
      </>}
    </section>
  </div>
}
