// src/feed/entries.ts — 信息流条目：组装候选 → 护栏 → 发布
// 激活率：activity 类候选按概率丢弃（防刷屏感），其余类型不受影响。

import { check } from './guard';
import { insertEntry, type Entry, type EntryType } from '../store/db';

export interface EntryCandidate {
  type: EntryType;
  residentIds: string[];
  location: string;
  content: string;
  title?: string;
  ts?: number;
}

export function draft(input: EntryCandidate): EntryCandidate {
  return input;
}

export interface PublishResult {
  published: Entry[];
  blocked: { candidate: EntryCandidate; reason: string }[];
  skipped: EntryCandidate[]; // 激活率丢弃
}

export async function publishAll(
  db: D1Database,
  candidates: EntryCandidate[],
  opts: { activationRate: number; rng?: () => number },
): Promise<PublishResult> {
  const rng = opts.rng ?? Math.random;
  const result: PublishResult = { published: [], blocked: [], skipped: [] };

  for (const candidate of candidates) {
    if (candidate.type === 'activity' && rng() > opts.activationRate) {
      result.skipped.push(candidate);
      continue;
    }

    const guardResult = await check(db, candidate.content, 'entry', null);
    if (guardResult !== 'ok') {
      result.blocked.push({ candidate, reason: guardResult.reason });
      continue;
    }

    const entry: Entry = {
      id: crypto.randomUUID(),
      ts: candidate.ts ?? Date.now(),
      type: candidate.type,
      residentIds: candidate.residentIds,
      location: candidate.location,
      title: candidate.title ?? null,
      content: candidate.content,
      status: 'published',
    };
    await insertEntry(db, entry);
    result.published.push(entry);
  }

  return result;
}
