/** 检索配置（S1：N6 全部可调常量的唯一定义处，环境变量可覆盖） */
export interface RetrievalConfig {
  recentFloor: number // RETRIEVAL_RECENT_FLOOR 缺省 5（新近保底条数）
  topK: number // RETRIEVAL_TOP_K 缺省 15（打分入选条数）
  summaryFloorPerLevel: number // RETRIEVAL_SUMMARY_FLOOR_PER_LEVEL 缺省 1（S2：每层级最新摘要保底条数，L1+L2 各取）
  w1: number // RETRIEVAL_W1 缺省 1.0（新近度衰减权重）
  w2: number // RETRIEVAL_W2 缺省 2.0（重要性权重;量程 0.2-2.0,须盖过新鲜琐事的衰减分,见 AC6）
  w3: number // RETRIEVAL_W3 缺省 1.0（情境匹配权重）
  halfLifeHours: number // RETRIEVAL_HALF_LIFE_HOURS 缺省 72（新近度半衰期,虚拟小时）
  candidateRecent: number // RETRIEVAL_CANDIDATE_RECENT 缺省 30（新近路候选 LIMIT）
  candidateImportant: number // RETRIEVAL_CANDIDATE_IMPORTANT 缺省 30（重要性路候选 LIMIT）
  candidateMentions: number // RETRIEVAL_CANDIDATE_MENTIONS 缺省 30（人物提及路候选 LIMIT）
  candidateAnnotated: number // RETRIEVAL_CANDIDATE_ANNOTATED 缺省 40（地点/主题带标注候选 LIMIT）
}

export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  recentFloor: 5,
  topK: 15,
  summaryFloorPerLevel: 1,
  w1: 1,
  w2: 2,
  w3: 1,
  halfLifeHours: 72,
  candidateRecent: 30,
  candidateImportant: 30,
  candidateMentions: 30,
  candidateAnnotated: 40,
}

export function retrievalConfig(env: {
  RETRIEVAL_RECENT_FLOOR?: string
  RETRIEVAL_TOP_K?: string
  RETRIEVAL_SUMMARY_FLOOR_PER_LEVEL?: string
  RETRIEVAL_W1?: string
  RETRIEVAL_W2?: string
  RETRIEVAL_W3?: string
  RETRIEVAL_HALF_LIFE_HOURS?: string
  RETRIEVAL_CANDIDATE_RECENT?: string
  RETRIEVAL_CANDIDATE_IMPORTANT?: string
  RETRIEVAL_CANDIDATE_MENTIONS?: string
  RETRIEVAL_CANDIDATE_ANNOTATED?: string
} = {}): RetrievalConfig {
  // 计数类:正整数;权重类:允许 0(golden 调参与 AC10 依赖归零);半衰期:正数
  const count = (v: string | undefined, dflt: number) => {
    const n = Number(v)
    return Number.isFinite(n) && Math.floor(n) > 0 ? Math.floor(n) : dflt
  }
  const weight = (v: string | undefined, dflt: number) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : dflt
  }
  return {
    recentFloor: count(env.RETRIEVAL_RECENT_FLOOR, DEFAULT_RETRIEVAL_CONFIG.recentFloor),
    topK: count(env.RETRIEVAL_TOP_K, DEFAULT_RETRIEVAL_CONFIG.topK),
    summaryFloorPerLevel: count(env.RETRIEVAL_SUMMARY_FLOOR_PER_LEVEL, DEFAULT_RETRIEVAL_CONFIG.summaryFloorPerLevel),
    w1: weight(env.RETRIEVAL_W1, DEFAULT_RETRIEVAL_CONFIG.w1),
    w2: weight(env.RETRIEVAL_W2, DEFAULT_RETRIEVAL_CONFIG.w2),
    w3: weight(env.RETRIEVAL_W3, DEFAULT_RETRIEVAL_CONFIG.w3),
    halfLifeHours: weight(env.RETRIEVAL_HALF_LIFE_HOURS, DEFAULT_RETRIEVAL_CONFIG.halfLifeHours) || DEFAULT_RETRIEVAL_CONFIG.halfLifeHours,
    candidateRecent: count(env.RETRIEVAL_CANDIDATE_RECENT, DEFAULT_RETRIEVAL_CONFIG.candidateRecent),
    candidateImportant: count(env.RETRIEVAL_CANDIDATE_IMPORTANT, DEFAULT_RETRIEVAL_CONFIG.candidateImportant),
    candidateMentions: count(env.RETRIEVAL_CANDIDATE_MENTIONS, DEFAULT_RETRIEVAL_CONFIG.candidateMentions),
    candidateAnnotated: count(env.RETRIEVAL_CANDIDATE_ANNOTATED, DEFAULT_RETRIEVAL_CONFIG.candidateAnnotated),
  }
}
