// src/feed/wordlist.ts — 护栏词表
// 定位：LLM 内容本来就产自良性 prompt，词表是安全网而非主防线。
// 每类给出原因说明，便于 moderation_log 追溯。

export const WORDLIST: Record<string, { reason: string; words: string[] }> = {
  crime: {
    reason: '犯罪/暴力细节（违背谜团温暖向原则）',
    words: [
      '杀人', '谋杀', '分尸', '藏尸', '碎尸', '血迹', '尸体', '命案', '凶器',
      '下毒', '投毒', '绑架', '抢劫', '盗窃手法', '自杀方法', '枪支', '炸药',
    ],
  },
  nsfw: {
    reason: '成人内容',
    words: ['做爱', '裸体', '色情', '援交', '约炮', '强奸', '性侵'],
  },
  politics: {
    reason: '政治敏感',
    words: ['颠覆国家', '暴动', '恐怖袭击', '邪教'],
  },
  hate: {
    reason: '仇恨/歧视言论',
    words: ['支那', '劣等民族', '去死吧', '死全家'],
  },
};

/** AI 出戏标记（人格崩坏兜底，仅 entry 检查） */
export const AI_LEAK_PATTERNS: { reason: string; patterns: RegExp[] } = {
  reason: 'AI 出戏（人格崩坏）',
  patterns: [
    /作为(一个)?AI/i,
    /作为(一个)?(大型)?语言模型/,
    /人工智能助手/,
    /我无法扮演/,
    /我是一个虚拟/,
  ],
};

/** 注入残留标记（仅 profile 检查：防 UGC 卡越狱槽位残留） */
export const INJECTION_PATTERNS: { reason: string; patterns: RegExp[] } = {
  reason: '疑似注入指令残留',
  patterns: [
    /忽略(之前的|上述|所有)(指令|指示|规则)/,
    /ignore (all |previous )?(instructions|rules)/i,
    /system prompt/i,
    /<\s*system\s*>/i,
    /越狱|jailbreak/i,
  ],
};
