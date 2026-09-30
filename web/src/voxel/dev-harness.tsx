import { useCallback, useEffect, useRef, useState } from 'react'
import { applyEdits, deserialize, serialize, type EditOperation, type StylePackRef, type TerrainParams, type ValidationIssue } from '@possibility/voxel-contract'
import { VoxelEngine, WebGL2UnavailableError } from './engine'
import { EditController } from './bridge/edit-controller'
import { InteractionRouter } from './bridge/interaction-router'
import { PlatformGate } from './bridge/platform-gate'
import { buildFixtureWorld, buildTerrainFixtureWorld } from './fixture'
import VoxelEditor from './ui/VoxelEditor'
import WalkHud from './ui/WalkHud'
import { planEditsViaApi as devPlanEdits } from './plan-edits'

/** e2e 探针：最近的产品交互事件（居民 / 地点 / 空间导航） */
interface InteractionEvent { kind: string; detail: string }
/** T36 性能探针：fps 采样 + 计时编辑（applyEdits + F4 局部重烘焙全路径） */
interface PerfProbe {
  sampleFps(seconds: number): Promise<number>
  timedEdit(ops: EditOperation[]): number
  timedEditTraced(ops: EditOperation[]): { contract: number; lighting: number; bake: number; upload: number; sections: number; total: number }
}
/** S3b 探针:地形重生成与风格包(走 EditController 真实链路) */
interface WorldProbe {
  getBlock(x: number, y: number, z: number): string
  getStyle(): StylePackRef | undefined
  getTerrainParams(): unknown
  getObjectCellCount(): number
  getAssetPlacements(): unknown[]
  getAssetInstanceCount(): number
  regen(params: TerrainParams): { ok: boolean; issues: ValidationIssue[] }
  setStyle(style: unknown): { ok: boolean }
}
declare global {
  interface Window { __voxelInteractions?: InteractionEvent[]; __voxelPerf?: PerfProbe; __voxelWorld?: WorldProbe }
}

/**
 * /dev/voxel 开发调试页：加载 fixture 世界（或传入的 VoxelDocument），
 * 时间/天气滑杆在对应 Track 落地后接入。e2e 通过 window.__voxelEngine 探针断言。
 */
export default function VoxelDevHarness() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<VoxelEngine | null>(null)
  const interactRef = useRef<((x: number, y: number) => boolean) | null>(null)
  const [controller, setController] = useState<EditController | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [interaction, setInteraction] = useState<InteractionEvent | null>(null)
  const [gate] = useState(() => new PlatformGate())
  // S2b 双视角(与 VoxelViewport 同一套接线,供 e2e 走查)
  const [cameraMode, setCameraMode] = useState<'orbit' | 'walk'>('orbit')
  const [modeNotice, setModeNotice] = useState<string | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const engine = new VoxelEngine()
    engineRef.current = engine
    ;(window as unknown as { __voxelEngine?: VoxelEngine }).__voxelEngine = engine
    window.__voxelInteractions = []
    window.__voxelPerf = {
      sampleFps: (seconds) => new Promise<number>((resolve) => {
        let frames = 0
        const prev = engine.onFrame
        engine.onFrame = (dt) => { prev?.(dt); frames++ }
        setTimeout(() => { engine.onFrame = prev; resolve(frames / seconds) }, seconds * 1000)
      }),
      timedEdit: (ops) => {
        const doc = engine.world?.doc
        if (!doc) throw new Error('世界尚未加载')
        const t0 = performance.now()
        engine.applyEditResult(applyEdits(doc, ops))
        return performance.now() - t0
      },
      timedEditTraced: (ops) => {
        const doc = engine.world?.doc
        if (!doc) throw new Error('世界尚未加载')
        const t0 = performance.now()
        const result = applyEdits(doc, ops)
        const t1 = performance.now()
        engine.applyEditResult(result)
        const total = performance.now() - t0
        const trace = engine.lastEditTrace ?? { lighting: 0, bake: 0, upload: 0, sections: 0 }
        return { contract: t1 - t0, ...trace, total }
      },
    }
    let cancelled = false
    void (async () => {
      try {
        engine.mount(canvas)
        // 真图集存在则优先使用，失败回退占位图集（T12 之后为真图集）
        try {
          await engine.loadAssets('mist-manor')
        } catch {
          await engine.loadAssets('mist-manor', { placeholder: true })
        }
        if (cancelled) return
        // T35 验收入口：localStorage['voxel-dev-load'] 有序列化文档则加载之,否则 fixture;
        // S3b:localStorage['voxel-dev-fixture']='terrain' 加载参数化地形 fixture
        const override = (() => {
          try {
            const raw = localStorage.getItem('voxel-dev-load')
            return raw ? deserialize(raw) : null
          } catch { return null }
        })()
        const fixture = (() => {
          try { return localStorage.getItem('voxel-dev-fixture') === 'terrain' ? buildTerrainFixtureWorld() : null } catch { return null }
        })()
        engine.loadDocument(override ?? fixture ?? buildFixtureWorld())
        engine.start()
        // 居民点位写死在平地 fixture 坐标;参数化地形世界地面起伏,跳过以免埋进地里
        if (!fixture) startFixtureResidents(engine)
        // 观察点击 → 产品交互（T28）：居民活动 / 地点详情 / 空间导航
        const router = new InteractionRouter(engine, {
          onPerson: (personId) => record(setInteraction, { kind: 'person', detail: describePerson(personId) }),
          onLocation: (objectId, locationName) => record(setInteraction, { kind: 'location', detail: `${locationName}（${objectId}）` }),
          onObjectPerson: (objectId, personId) => record(setInteraction, { kind: 'object-person', detail: `${objectId} → ${personId}` }),
          onObject: (objectId) => record(setInteraction, { kind: 'object', detail: objectId }),
          onEnterSpace: (spaceId) => record(setInteraction, { kind: 'enter-space', detail: spaceId }),
        })
        interactRef.current = (x, y) => router.handleClick(x, y)
        // 开发页编辑：保存到 localStorage（产品层接服务端）
        const editController = new EditController({
          engine,
          canEdit: gate.canEdit,
          save: (doc) => {
            try { localStorage.setItem('voxel-dev-doc', serialize(doc)) } catch { /* 容量满则忽略 */ }
          },
        })
        setController(editController)
        // S3b 探针:全部显式传参(page.evaluate 闭包读不到 Node 侧常量)
        window.__voxelWorld = {
          getBlock: (x, y, z) => engine.world?.getBlock({ x, y, z }) ?? 'air',
          getStyle: () => engine.getStyle(),
          getTerrainParams: () => engine.world?.doc.terrain?.params ?? null,
          getObjectCellCount: () => engine.world?.doc.objectCells.length ?? 0,
          getAssetPlacements: () => engine.world?.doc.assetPlacements ?? [],
          getAssetInstanceCount: () => engine.assets.instanceCount,
          regen: (params) => {
            const outcome = editController.regenerateTerrain(params)
            return { ok: outcome.ok, issues: outcome.issues }
          },
          setStyle: (style) => ({ ok: editController.setStyle(style).ok }),
        }
        setReady(true)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof WebGL2UnavailableError ? err.message : `体素引擎启动失败：${String(err)}`)
        }
      }
    })()
    return () => {
      cancelled = true
      engine.dispose()
      engineRef.current = null
      interactRef.current = null
      delete (window as unknown as { __voxelEngine?: VoxelEngine }).__voxelEngine
      delete window.__voxelInteractions
      delete window.__voxelPerf
      delete window.__voxelWorld
    }
  }, [gate])

  const toggleCameraMode = useCallback(() => {
    const engine = engineRef.current
    if (!engine) return
    const next = cameraMode === 'orbit' ? 'walk' : 'orbit'
    const result = engine.setCameraMode(next)
    if (result.ok) {
      setCameraMode(next)
      setModeNotice(null)
    } else {
      setModeNotice(result.reason ?? '当前无法切换视角')
      setTimeout(() => setModeNotice(null), 3000)
    }
  }, [cameraMode])
  useEffect(() => {
    if (!gate.showFirstPerson) return
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyV' || e.repeat) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      toggleCameraMode()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [gate, toggleCameraMode])

  // 第一视角:点击 = 屏幕中心(准星)射线,只读选中(F4)
  useEffect(() => {
    if (!ready || cameraMode !== 'walk') return
    const canvas = engineRef.current?.renderer.canvas
    if (!canvas) return
    const onClick = () => {
      const rect = canvas.getBoundingClientRect()
      interactRef.current?.(rect.left + rect.width / 2, rect.top + rect.height / 2)
    }
    canvas.addEventListener('click', onClick)
    return () => canvas.removeEventListener('click', onClick)
  }, [ready, cameraMode])

  if (error) {
    return (
      <div className="grid h-screen place-items-center bg-zinc-900 p-8 text-center text-sm text-zinc-200" data-testid="voxel-error">
        {error}
      </div>
    )
  }

  return (
    <div className="relative h-screen w-full overflow-hidden bg-zinc-950" data-testid="voxel-dev">
      <canvas ref={canvasRef} className="h-full w-full touch-none" data-testid="voxel-canvas" />
      {!ready && (
        <div className="absolute inset-0 grid place-items-center text-sm text-zinc-400" data-testid="voxel-loading">
          正在加载体素世界…
        </div>
      )}
      <div className="pointer-events-none absolute left-3 top-3 rounded bg-black/55 px-3 py-2 text-xs leading-5 text-zinc-200">
        <div className="font-medium">体素开发页 · 雾影庄 fixture</div>
        <div className="text-zinc-400">
          {cameraMode === 'orbit' ? '左键拖动旋转 · 右键/Shift 拖动平移 · 滚轮缩放' : '第一视角游览中(只读)'}
        </div>
      </div>
      {ready && gate.showFirstPerson && (
        <WalkHud mode={cameraMode} onToggle={toggleCameraMode} notice={modeNotice} />
      )}
      {ready && <DevControls engine={engineRef} />}
      {ready && controller && cameraMode === 'orbit' && (
        <VoxelEditor
          engine={engineRef.current!}
          controller={controller}
          planEdits={(intent) => devPlanEdits(engineRef.current!, intent)}
          interact={(x, y) => interactRef.current?.(x, y) ?? false}
          editing={gate.showEditing}
        />
      )}
      {interaction && (
        <div className="pointer-events-auto absolute right-3 top-3 max-w-xs rounded bg-black/60 px-3 py-2 text-xs leading-5 text-zinc-100" data-testid="voxel-activity-panel">
          <div className="text-zinc-400">{INTERACTION_LABELS[interaction.kind] ?? interaction.kind}</div>
          <div data-testid="voxel-activity-detail">{interaction.detail}</div>
        </div>
      )}
    </div>
  )
}

const INTERACTION_LABELS: Record<string, string> = {
  person: '居民活动',
  location: '地点',
  'object-person': '人物相关物体',
  object: '物体',
  'enter-space': '空间导航（fixture 单空间，仅记录）',
}

function record(set: (e: InteractionEvent) => void, event: InteractionEvent): void {
  window.__voxelInteractions?.push(event)
  set(event)
}

const PERSON_NAMES: Record<string, string> = {
  'resident-sayo': '小夜',
  'resident-ichinose': '柊一成',
}

/** 居民当前活动由 startFixtureResidents 的每次同步更新 */
const residentActivities = new Map<string, string>()

function describePerson(personId: string): string {
  const name = PERSON_NAMES[personId] ?? personId
  const activity = residentActivities.get(personId)
  return activity ? `${name} · ${activity}` : name
}

const WEATHERS = [
  { id: 'clear', label: '晴', state: {} },
  { id: 'rain', label: '雨', state: { rain: 1 } },
  { id: 'snow', label: '雪', state: { snow: 1 } },
  { id: 'fog', label: '雾', state: { fog: 1 } },
] as const

function DevControls({ engine }: { engine: React.RefObject<VoxelEngine | null> }) {
  const [time, setTime] = useState(0.4)
  const [weather, setWeather] = useState<string>('clear')

  useEffect(() => {
    engine.current?.setTimeOfDay(time)
  }, [engine, time])

  return (
    <div className="absolute bottom-3 left-3 flex items-center gap-3 rounded bg-black/55 px-3 py-2 text-xs text-zinc-200" data-testid="voxel-dev-controls">
      <label className="flex items-center gap-2">
        时间
        <input
          data-testid="voxel-time-slider"
          type="range" min={0} max={1} step={0.01} value={time}
          onChange={(e) => setTime(Number(e.target.value))}
          className="w-40"
        />
        <span className="w-10 text-zinc-400">{formatTime(time)}</span>
      </label>
      <div className="flex gap-1" data-testid="voxel-weather-buttons">
        {WEATHERS.map((w) => (
          <button
            key={w.id}
            data-testid={`voxel-weather-${w.id}`}
            className={`rounded px-2 py-1 ${weather === w.id ? 'bg-sky-600 text-white' : 'bg-zinc-700/70 text-zinc-300'}`}
            onClick={() => {
              setWeather(w.id)
              engine.current?.setWeather(w.state)
            }}
          >
            {w.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function formatTime(t: number): string {
  const hours = Math.floor(t * 24)
  const minutes = Math.floor((t * 24 - hours) * 60)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

/** fixture 居民：在庭院与主楼之间往返（T19 开发页验证） */
const RESIDENT_SPOTS = {
  courtyard: { x: 23, y: 2, z: 33 },
  houseDoor: { x: 23, y: 1, z: 26 },
  pond: { x: 35, y: 2, z: 29 },
}

function startFixtureResidents(engine: VoxelEngine): void {
  let phase = 0
  const sync = () => {
    phase += 1
    const toHouse = phase % 2 === 1
    const sayoActivity = toHouse ? '回主楼' : '到庭院散步'
    const ichinoseActivity = toHouse ? '穿过庭院' : '去池塘边'
    residentActivities.set('resident-sayo', sayoActivity)
    residentActivities.set('resident-ichinose', ichinoseActivity)
    engine.syncResidents([
      {
        personId: 'resident-sayo', name: '小夜',
        at: RESIDENT_SPOTS.courtyard,
        destination: toHouse ? RESIDENT_SPOTS.houseDoor : RESIDENT_SPOTS.courtyard,
        activity: sayoActivity,
      },
      {
        personId: 'resident-ichinose', name: '柊一成',
        at: RESIDENT_SPOTS.pond,
        destination: toHouse ? RESIDENT_SPOTS.courtyard : RESIDENT_SPOTS.pond,
        activity: ichinoseActivity,
      },
    ])
  }
  sync()
  const timer = setInterval(sync, 9000)
  const originalDispose = engine.dispose.bind(engine)
  engine.dispose = () => {
    clearInterval(timer)
    originalDispose()
  }
}
