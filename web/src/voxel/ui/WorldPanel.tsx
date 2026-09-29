import { useState } from 'react'
import {
  STYLE_PRESETS, STYLE_TWEAK_RANGES, TERRAIN_QUOTAS,
  type StylePackRef, type TerrainParams, type ValidationIssue,
} from '@possibility/voxel-contract'
import type { VoxelEngine } from '../engine'
import type { EditController } from '../bridge/edit-controller'

export interface WorldPanelProps {
  engine: VoxelEngine
  controller: EditController
}

interface TerrainForm {
  amplitude: number
  scale: number
  riverEnabled: boolean
  riverWidth: number
  lakesEnabled: boolean
  lakeSize: number
  density: number
  trees: boolean
  flowers: boolean
  bushes: boolean
  seed: number
}

const DEFAULT_FORM: TerrainForm = {
  amplitude: 4, scale: 24,
  riverEnabled: false, riverWidth: 2,
  lakesEnabled: false, lakeSize: 4,
  density: 0.03, trees: true, flowers: true, bushes: true,
  seed: 1,
}

function formFromParams(params: TerrainParams & { seed: number }): TerrainForm {
  return {
    amplitude: params.elevation?.amplitude ?? 0,
    scale: params.elevation?.scale ?? 24,
    riverEnabled: params.river?.enabled ?? false,
    riverWidth: params.river?.width ?? 2,
    lakesEnabled: params.lakes?.enabled ?? false,
    lakeSize: params.lakes?.size ?? 4,
    density: params.vegetation?.density ?? 0,
    trees: params.vegetation?.trees ?? true,
    flowers: params.vegetation?.flowers ?? true,
    bushes: params.vegetation?.bushes ?? true,
    seed: params.seed,
  }
}

function formToParams(form: TerrainForm): TerrainParams {
  return {
    seed: form.seed,
    elevation: { amplitude: form.amplitude, scale: form.scale },
    river: { enabled: form.riverEnabled, width: form.riverWidth },
    lakes: { enabled: form.lakesEnabled, size: form.lakeSize },
    vegetation: {
      density: form.density,
      trees: form.trees,
      flowers: form.flowers,
      bushes: form.bushes,
    },
  }
}

const label = 'text-zinc-400'
const numInput = 'w-full rounded bg-zinc-700/70 px-1.5 py-0.5 text-zinc-200'

/** 「世界」面板:地形参数查看/调参/重新生成 + 风格包预设与微调(S3b F7/F10) */
export default function WorldPanel({ engine, controller }: WorldPanelProps) {
  const doc = engine.world?.doc
  const terrainMeta = doc?.terrain
  const [form, setForm] = useState<TerrainForm>(() => (terrainMeta ? formFromParams(terrainMeta.params) : DEFAULT_FORM))
  const [issues, setIssues] = useState<ValidationIssue[] | null>(null)
  const [tweaks, setTweaks] = useState({ fogDensity: 0, exposure: 0, saturation: 0 })

  const patch = (p: Partial<TerrainForm>) => setForm((f) => ({ ...f, ...p }))

  const handleRegen = () => {
    const outcome = controller.regenerateTerrain(formToParams(form))
    setIssues(outcome.ok ? outcome.issues : outcome.issues)
  }

  const applyStyle = (preset: string, tw = tweaks) => {
    const style: StylePackRef = { preset, tweaks: { ...tw } }
    controller.setStyle(style)
  }

  const commitTweaks = () => applyStyle(engine.getStyle()?.preset ?? 'default')

  const currentPreset = engine.getStyle()?.preset ?? 'default'
  const clamps = [...(terrainMeta?.clamps ?? []), ...(doc?.style?.clamps ?? [])]

  const numField = (text: string, value: number, onChange: (v: number) => void, opts: { min: number; max: number; step?: number; disabled?: boolean }) => (
    <label className="flex items-center justify-between gap-2">
      <span className={label}>{text}</span>
      <input
        type="number"
        className={numInput}
        value={value}
        min={opts.min}
        max={opts.max}
        step={opts.step ?? 1}
        disabled={opts.disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  )

  const toggle = (text: string, value: boolean, onChange: (v: boolean) => void, disabled?: boolean) => (
    <label className="flex items-center justify-between gap-2">
      <span className={label}>{text}</span>
      <input type="checkbox" checked={value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  )

  return (
    <div className="flex w-60 flex-col gap-3 rounded bg-black/60 p-3 text-xs text-zinc-200" data-testid="voxel-world-panel">
      <div className="font-medium text-zinc-100">世界</div>

      {/* ── 地形 ─────────────────────────── */}
      {terrainMeta ? (
        <div className="flex flex-col gap-1.5" data-testid="voxel-terrain-form">
          <div className="text-zinc-300">地形参数</div>
          {numField('起伏振幅', form.amplitude, (v) => patch({ amplitude: v }), { min: 0, max: TERRAIN_QUOTAS.amplitudeMax })}
          {numField('起伏尺度', form.scale, (v) => patch({ scale: v }), { min: TERRAIN_QUOTAS.scaleMin, max: TERRAIN_QUOTAS.scaleMax })}
          {toggle('河流', form.riverEnabled, (v) => patch({ riverEnabled: v }))}
          {numField('河宽', form.riverWidth, (v) => patch({ riverWidth: v }), { min: TERRAIN_QUOTAS.riverWidthMin, max: TERRAIN_QUOTAS.riverWidthMax, disabled: !form.riverEnabled })}
          {toggle('湖泊/池塘', form.lakesEnabled, (v) => patch({ lakesEnabled: v }))}
          {numField('湖泊大小', form.lakeSize, (v) => patch({ lakeSize: v }), { min: TERRAIN_QUOTAS.lakeSizeMin, max: TERRAIN_QUOTAS.lakeSizeMax, disabled: !form.lakesEnabled })}
          {numField('植被密度', form.density, (v) => patch({ density: v }), { min: 0, max: TERRAIN_QUOTAS.densityMax, step: 0.01 })}
          {toggle('树', form.trees, (v) => patch({ trees: v }))}
          {toggle('花', form.flowers, (v) => patch({ flowers: v }))}
          {toggle('灌木', form.bushes, (v) => patch({ bushes: v }))}
          <div className="flex items-center justify-between gap-2">
            <span className={label}>种子 {form.seed}</span>
            <button
              className="rounded bg-zinc-700/70 px-2 py-0.5 hover:bg-zinc-600"
              data-testid="voxel-seed-reroll"
              onClick={() => patch({ seed: Math.floor(Math.random() * 0x7fffffff) })}
            >
              换种子
            </button>
          </div>
          <button
            className="mt-1 rounded bg-sky-600 px-2 py-1 text-white hover:bg-sky-500"
            data-testid="voxel-regen-button"
            onClick={handleRegen}
          >
            重新生成地形
          </button>
          <div className="text-zinc-500">重生成会覆盖地形层(含手工改过的地形格),建筑与物体保留</div>
          {issues !== null && (
            <div className="flex flex-col gap-0.5 rounded border border-zinc-600 p-1.5" data-testid="voxel-regen-issues">
              {issues.length === 0 ? (
                <span className="text-emerald-300">校验通过</span>
              ) : (
                issues.slice(0, 6).map((i, idx) => (
                  <span key={idx} className="text-amber-300">
                    {i.code}{i.at ? `@(${i.at.x},${i.at.y},${i.at.z})` : ''}: {i.message}
                  </span>
                ))
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="text-zinc-500" data-testid="voxel-terrain-none">
          当前世界不是参数化地形世界,无地形可调
        </div>
      )}

      {/* ── 风格包 ────────────────────────── */}
      <div className="flex flex-col gap-1.5" data-testid="voxel-style-form">
        <div className="text-zinc-300">风格包</div>
        <div className="grid grid-cols-2 gap-1">
          {STYLE_PRESETS.map((p) => (
            <button
              key={p.id}
              data-testid={`voxel-style-preset-${p.id}`}
              className={`rounded px-2 py-1 ${currentPreset === p.id ? 'bg-sky-600 text-white' : 'bg-zinc-700/70 hover:bg-zinc-600'}`}
              onClick={() => applyStyle(p.id)}
            >
              {p.name}
            </button>
          ))}
        </div>
        {(['fogDensity', 'exposure', 'saturation'] as const).map((key) => (
          <label key={key} className="flex items-center gap-2">
            <span className={`${label} w-14`}>{key === 'fogDensity' ? '雾密度' : key === 'exposure' ? '曝光' : '饱和度'}</span>
            <input
              type="range"
              className="flex-1"
              min={-STYLE_TWEAK_RANGES[key]}
              max={STYLE_TWEAK_RANGES[key]}
              step={0.05}
              value={tweaks[key]}
              data-testid={`voxel-style-tweak-${key}`}
              onChange={(e) => setTweaks((t) => ({ ...t, [key]: Number(e.target.value) }))}
              onPointerUp={commitTweaks}
              onKeyUp={commitTweaks}
            />
            <span className="w-8 text-right text-zinc-400">{tweaks[key].toFixed(2)}</span>
          </label>
        ))}
      </div>

      {/* ── 夹取记录 ──────────────────────── */}
      {clamps.length > 0 && (
        <div className="flex flex-col gap-0.5 rounded border border-zinc-600 p-1.5" data-testid="voxel-clamp-records">
          <span className="text-zinc-400">配额夹取记录</span>
          {clamps.slice(0, 6).map((c, idx) => (
            <span key={idx} className="text-zinc-500">{c.field}: {String(c.from)} → {String(c.to)}</span>
          ))}
        </div>
      )}
    </div>
  )
}
