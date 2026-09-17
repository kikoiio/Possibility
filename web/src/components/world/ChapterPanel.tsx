import { useCallback, useEffect, useState } from 'react'
import { chaptersApi } from '../../api/client'
import type { Chapter, ChapterSummary } from '../../api/types'

interface Props {
  worldId: string
  timelineId: string
  onClose: () => void
}

function fmtSim(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ')
}

/** 章节面板：世界事件流的小说化回顾；每次生成消耗 1 次 LLM 调用（走预算护栏） */
export default function ChapterPanel({ worldId, timelineId, onClose }: Props) {
  const [list, setList] = useState<ChapterSummary[] | null>(null)
  const [current, setCurrent] = useState<Chapter | null>(null)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')

  const reload = useCallback(() => {
    chaptersApi
      .list(worldId, timelineId)
      .then((d) => setList(d.chapters))
      .catch(() => setError('章节列表加载失败'))
  }, [worldId, timelineId])

  useEffect(reload, [reload])

  const handleGenerate = async () => {
    if (generating) return
    setError('')
    setGenerating(true)
    try {
      const chapter = await chaptersApi.generate(worldId, timelineId)
      setCurrent(chapter)
      reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : '章节生成失败')
    } finally {
      setGenerating(false)
    }
  }

  const handleOpen = async (id: string) => {
    setError('')
    try {
      setCurrent(await chaptersApi.get(id))
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink/30 p-4" onClick={onClose}>
      <div
        className="flex h-[80vh] w-full max-w-2xl flex-col rounded-2xl border border-ink-line bg-paper shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ink-line/60 px-5 py-3">
          <h2 className="font-story text-lg font-semibold text-ink">章节</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="rounded-lg bg-ink px-3 py-1.5 text-xs text-white disabled:opacity-50"
            >
              {generating ? '驻场叙事者奋笔中…' : '写下一章'}
            </button>
            <button onClick={onClose} className="text-xs text-ink-faint transition-colors hover:text-ink-soft">
              关闭
            </button>
          </div>
        </div>

        {error && <p className="border-b border-red-100 bg-red-50 px-5 py-2 text-xs text-red-600">{error}</p>}

        <div className="flex min-h-0 flex-1">
          {/* 章节目录 */}
          <aside className="w-52 shrink-0 overflow-y-auto border-r border-ink-line/60 px-3 py-3">
            {!list && <p className="text-xs text-ink-faint">加载中…</p>}
            {list && list.length === 0 && (
              <p className="text-xs leading-relaxed text-ink-faint">
                还没有章节。
                <br />
                点「写下一章」，把这段时间世界里发生的事写成一篇小说。
              </p>
            )}
            <ul className="space-y-1.5">
              {(list ?? []).map((ch) => (
                <li key={ch.id}>
                  <button
                    onClick={() => void handleOpen(ch.id)}
                    className={`w-full rounded-lg px-2.5 py-2 text-left transition-colors ${
                      current?.id === ch.id ? 'bg-paper-deep' : 'hover:bg-paper-deep/60'
                    }`}
                  >
                    <p className="font-story truncate text-[13px] text-ink">{ch.title}</p>
                    <p className="mt-0.5 text-[11px] text-ink-faint">
                      {fmtSim(ch.fromSim)} ~ {fmtSim(ch.toSim).slice(5)} · {ch.eventCount} 件事
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          {/* 正文 */}
          <main className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
            {current ? (
              <article>
                <h3 className="font-story mb-4 text-xl font-semibold text-ink">{current.title}</h3>
                <p className="font-story whitespace-pre-wrap text-[15px] leading-[1.9] text-ink-soft">{current.content}</p>
              </article>
            ) : (
              <p className="pt-16 text-center text-sm text-ink-faint">
                {generating ? '正在把这段时间的世界写成一章小说……' : '从左侧选择一章，或点「写下一章」。'}
              </p>
            )}
          </main>
        </div>
      </div>
    </div>
  )
}
