/**
 * ZoomLod(S3a F6):zoom 刻度 → 三档渲染 LOD 的滞回档位机 + 分档参数表。
 * - 档位与 S3b 事件披露层级共用同一刻度基准(overview 全貌 / district 街区 / close 近距)
 * - 参数为库内常量(spec:不做配置界面,AI 与用户均不可调)
 * - 跨档才回调;边界滞回防止刻度小幅往复时档位抖动(AC6)
 */

export type ZoomTier = 'overview' | 'district' | 'close'

export interface TierParams {
  /** 乘 palette.shadow.mapSize(引擎层换算取整后走 setDirectLight) */
  shadowMapScale: number
  /** 乘风格包 particleDensity(天气+环境粒子,门面层合成) */
  particleDensity: number
  /** 乘资产摇摆振幅;0 时跳过矩阵重算(overview 零开销) */
  swayScale: number
  /** 乘 resolved.post 的 bloom 强度 */
  bloomScale: number
  /** 乘 resolved.fog.density(全貌略增雾感,大气透视) */
  fogScale: number
}

/** 档位边界(初值,目检拍板可调):[0,B1) 全貌 / [B1,B2) 街区 / [B2,1] 近距 */
export const TIER_BOUNDARY_1 = 0.4
export const TIER_BOUNDARY_2 = 0.72
/** 每边界滞回半幅:升档须越过 边界+H,降档须越过 边界−H */
export const TIER_HYSTERESIS = 0.03

export const TIER_PARAMS: Record<ZoomTier, TierParams> = {
  overview: { shadowMapScale: 0.5, particleDensity: 0.4, swayScale: 0, bloomScale: 0.6, fogScale: 1.15 },
  district: { shadowMapScale: 0.75, particleDensity: 0.7, swayScale: 0.6, bloomScale: 0.85, fogScale: 1 },
  close: { shadowMapScale: 1, particleDensity: 1, swayScale: 1, bloomScale: 1, fogScale: 1 },
}

const TIER_ORDER: ZoomTier[] = ['overview', 'district', 'close']

export class ZoomLod {
  private currentTier: ZoomTier | null = null
  /** 跨档回调;首次 update 直接落定不回调(避免启动期全局抖动) */
  onTierChange: ((tier: ZoomTier, params: TierParams) => void) | null = null

  get tier(): ZoomTier {
    return this.currentTier ?? 'district'
  }

  get params(): TierParams {
    return TIER_PARAMS[this.tier]
  }

  /** 每帧以平滑刻度驱动;滞回判定,跨档才回调 */
  update(zoom: number): void {
    if (this.currentTier === null) {
      this.currentTier = this.classify(zoom)
      return
    }
    const next = this.classifyWithHysteresis(zoom, this.currentTier)
    if (next === this.currentTier) return
    this.currentTier = next
    this.onTierChange?.(next, TIER_PARAMS[next])
  }

  private classify(zoom: number): ZoomTier {
    if (zoom < TIER_BOUNDARY_1) return 'overview'
    if (zoom < TIER_BOUNDARY_2) return 'district'
    return 'close'
  }

  /** 只有跨档方向越过 边界±滞回 才翻档;滞回带内维持原档 */
  private classifyWithHysteresis(zoom: number, from: ZoomTier): ZoomTier {
    const idx = TIER_ORDER.indexOf(from)
    // 升档:越过上方边界 +H
    if (idx < TIER_ORDER.length - 1) {
      const upper = idx === 0 ? TIER_BOUNDARY_1 : TIER_BOUNDARY_2
      if (zoom >= upper + TIER_HYSTERESIS) return TIER_ORDER[idx + 1]
    }
    // 降档:越过下方边界 −H
    if (idx > 0) {
      const lower = idx === 1 ? TIER_BOUNDARY_1 : TIER_BOUNDARY_2
      if (zoom < lower - TIER_HYSTERESIS) return TIER_ORDER[idx - 1]
    }
    return from
  }
}
