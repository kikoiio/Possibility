import { useEffect, type ReactNode } from 'react'
import Portal from './Portal'

export interface DialogProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  description?: ReactNode
  children: ReactNode
  maxWidthClassName?: string
  ariaLabel?: string
}

export default function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  maxWidthClassName = 'max-w-lg',
  ariaLabel = '对话框',
}: DialogProps) {
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
        className="fixed inset-0 z-modal flex items-center justify-center p-4 sm:p-6"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : ariaLabel}
      >
        {/* 背景遮罩 */}
        <div
          className="fixed inset-0 bg-ink/40 backdrop-blur-sm animate-fade-in"
          onClick={onClose}
          aria-hidden="true"
        />

        {/* 弹窗主体 */}
        <div
          className={`relative z-10 max-h-[85vh] w-full overflow-y-auto rounded-2xl border border-ink-line/80 bg-sheet p-6 shadow-2xl backdrop-blur-xl animate-fade-in-up ${maxWidthClassName}`}
        >
          {/* 弹窗头部 */}
          {(title || description) && (
            <div className="mb-4 flex items-start justify-between">
              <div>
                {title && <h2 className="font-story text-lg font-medium text-ink">{title}</h2>}
                {description && <p className="mt-1 text-xs text-ink-faint leading-relaxed">{description}</p>}
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="关闭对话框"
                className="rounded-full p-1.5 text-ink-faint transition hover:bg-paper-deep hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}

          {/* 弹窗内容区 */}
          <div>{children}</div>
        </div>
      </div>
    </Portal>
  )
}
