import { useEffect, type ReactNode } from 'react'
import Portal from './Portal'

export interface DrawerProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  description?: ReactNode
  children: ReactNode
  widthClassName?: string
  ariaLabel?: string
}

export default function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  widthClassName = 'w-[min(26rem,calc(100vw-1.5rem))]',
  ariaLabel = '侧边抽屉面板',
}: DrawerProps) {
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) return null

  return (
    <Portal>
      <div
        className="fixed inset-0 z-drawer flex justify-end"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : ariaLabel}
      >
        {/* 背景遮罩 */}
        <div
          className="fixed inset-0 bg-ink/35 backdrop-blur-sm animate-fade-in transition-opacity"
          onClick={onClose}
          aria-hidden="true"
        />

        {/* 抽屉主体 */}
        <aside
          className={`relative z-10 flex h-full flex-col border-l border-ink-line/70 bg-sheet/95 shadow-2xl backdrop-blur-xl animate-slide-in-right ${widthClassName}`}
        >
          {/* 抽屉头部 */}
          <div className="flex items-start justify-between border-b border-ink-line/60 px-5 py-4">
            <div className="pr-4">
              {title && <h2 className="font-story text-base font-medium text-ink">{title}</h2>}
              {description && <p className="mt-1 text-xs text-ink-faint">{description}</p>}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭抽屉"
              className="rounded-full p-1.5 text-ink-faint transition hover:bg-paper-deep hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* 抽屉内容区 */}
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {children}
          </div>
        </aside>
      </div>
    </Portal>
  )
}
