// src/feed/guard.ts — 内容护栏：规则 + 词表
// 检查对象：信息流条目（发布前）、人格档案（载入时）。拦截一律留记录。

import { insertModerationLog } from '../store/db';
import { AI_LEAK_PATTERNS, INJECTION_PATTERNS, WORDLIST } from './wordlist';

export type GuardContext = 'entry' | 'profile';
export type GuardResult = 'ok' | { reason: string };

const MAX_ENTRY_LENGTH = 2000;

/**
 * 内容检查。命中时写 moderation_log 并返回原因。
 * @param targetId 条目 id 或档案 id（记录用）
 */
export async function check(
  db: D1Database,
  text: string,
  context: GuardContext,
  targetId: string | null = null,
): Promise<GuardResult> {
  const fail = async (reason: string): Promise<{ reason: string }> => {
    await insertModerationLog(db, {
      ts: Date.now(),
      targetType: context,
      targetId,
      action: 'blocked',
      reason,
    });
    return { reason };
  };

  if (context === 'entry' && text.length > MAX_ENTRY_LENGTH) {
    return fail(`条目超长（${text.length} > ${MAX_ENTRY_LENGTH}）`);
  }

  for (const { reason, words } of Object.values(WORDLIST)) {
    for (const word of words) {
      if (text.includes(word)) {
        return fail(`${reason}：命中「${word}」`);
      }
    }
  }

  if (context === 'entry') {
    for (const pattern of AI_LEAK_PATTERNS.patterns) {
      if (pattern.test(text)) {
        return fail(`${AI_LEAK_PATTERNS.reason}：命中 ${pattern}`);
      }
    }
  }

  if (context === 'profile') {
    for (const pattern of INJECTION_PATTERNS.patterns) {
      if (pattern.test(text)) {
        return fail(`${INJECTION_PATTERNS.reason}：命中 ${pattern}`);
      }
    }
  }

  return 'ok';
}
