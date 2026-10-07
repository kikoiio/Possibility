import type { PaneId, PresentationKind } from './presentation-types'

export interface PresentationSwitcherProps {
  paneId: PaneId
  value: PresentationKind
  onChange: (presentation: PresentationKind) => void
  disabled?: boolean
}

const PANE_LABELS: Record<PaneId, string> = {
  single: '世界画面', left: '左侧画面', right: '右侧画面',
}

/** Controlled selection only; the pane host owns loading, availability and persistence. */
export default function PresentationSwitcher({
  paneId, value, onChange, disabled = false,
}: PresentationSwitcherProps) {
  return (
    <div
      role="group"
      aria-label={`${PANE_LABELS[paneId]}表现`}
      data-testid={`presentation-switcher-${paneId}`}
      className="inline-flex flex-wrap items-center gap-1 rounded-full border border-ink-line/80 bg-sheet/90 p-1 text-xs text-ink-soft backdrop-blur-sm"
    >
      {(['native2d', 'voxel3d'] as const).map(kind => (
        <button
          key={kind}
          type="button"
          aria-pressed={value === kind}
          disabled={disabled}
          onClick={() => { if (!disabled && kind !== value) onChange(kind) }}
          className={`min-h-11 min-w-11 rounded-full px-3 py-2 font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sage-700 disabled:cursor-wait disabled:opacity-50 motion-reduce:transition-none ${
            value === kind ? 'bg-sage-800 text-white' : 'hover:bg-sage-100'
          }`}
        >
          {kind === 'native2d' ? '2D' : '3D'}
        </button>
      ))}
    </div>
  )
}
