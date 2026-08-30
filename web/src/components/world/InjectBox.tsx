import { useState } from 'react'

interface Props {
  onInject: (text: string) => Promise<void>
}

/** 注入事件输入框：主人以自然语言向当前时间线注入一个世界事件（F7） */
export default function InjectBox({ onInject }: Props) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const t = text.trim()
    if (!t || busy) return
    setBusy(true)
    try {
      await onInject(t)
      setText('')
    } catch {
      // 错误由父级展示
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mb-3 flex gap-2">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void submit()}
        placeholder="注入一个世界事件，例如：突然下起暴雨"
        className="min-w-0 flex-1 rounded-xl border border-ink-line bg-sheet px-3 py-2 text-sm text-ink-soft placeholder:text-ink-faint focus:border-ink-faint focus:outline-none"
      />
      <button
        onClick={() => void submit()}
        disabled={!text.trim() || busy}
        className="shrink-0 rounded-xl bg-cinnabar px-4 py-2 text-sm text-white transition-colors hover:bg-cinnabar-deep disabled:bg-ink-faint"
      >
        注入
      </button>
    </div>
  )
}
