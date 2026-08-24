// src/persona/profile.ts — 人格档案解析与校验
// 档案格式（personas/<id>/profile.md）：
//   frontmatter：id/name/age/role/home/haunts/schedule/relations/likes/dislikes
//   正文小节：## description / ## personality / ## speechStyle / ## scenario
//             / ## dialogueExamples（- 列表）/ ## secrets（可选）
// 存储：发布脚本写入 D1 profiles 表，运行时从 D1 读取。

import matter from 'gray-matter';
import { z } from 'zod';
import { check } from '../feed/guard';
import { isLocation, LOCATIONS } from '../world/locations';

const hhmm = z.string().regex(/^\d{2}:\d{2}$/, '须为 HH:MM 格式');

export const timeBlockSchema = z.object({
  start: hhmm,
  end: hhmm,
  location: z.string(),
  activity: z.string().min(1),
});
export type TimeBlock = z.infer<typeof timeBlockSchema>;

export const residentProfileSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'id 须为小写字母/数字/连字符'),
  name: z.string().min(1),
  age: z.number().int().positive(),
  role: z.string().min(1),
  description: z.string().min(1, '缺 ## description 小节'),
  personality: z.string().min(1, '缺 ## personality 小节'),
  speechStyle: z.string().min(1, '缺 ## speechStyle 小节'),
  likes: z.array(z.string()).default([]),
  dislikes: z.array(z.string()).default([]),
  scenario: z.string().min(1, '缺 ## scenario 小节'),
  dialogueExamples: z.array(z.string()).default([]),
  schedule: z.array(timeBlockSchema).min(1, 'schedule 至少一个时间块'),
  home: z.string().min(1),
  haunts: z.array(z.string()).default([]),
  relations: z.record(z.string(), z.string()).default({}),
  secrets: z.string().optional(),
});
export type ResidentProfile = z.infer<typeof residentProfileSchema>;

/** 档案校验错误：field 指名出问题的字段（AC2） */
export class ProfileError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(`${field}: ${message}`);
    this.name = 'ProfileError';
  }
}

const REQUIRED_SECTIONS = ['description', 'personality', 'speechStyle', 'scenario'] as const;

function splitSections(body: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const parts = body.split(/^##\s+(\w+)\s*$/m);
  // parts: [前言, 标题1, 内容1, 标题2, 内容2, ...]
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const key = parts[i]!;
    sections[key] = parts[i + 1]!.trim();
  }
  return sections;
}

function parseDialogueExamples(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

/** 解析单份档案文本。所有问题都以 ProfileError 抛出并指名字段。 */
export function parseProfile(raw: string): ResidentProfile {
  let data: Record<string, unknown>;
  let content: string;
  try {
    const parsed = matter(raw);
    data = parsed.data;
    content = parsed.content;
  } catch (e) {
    throw new ProfileError('frontmatter', `解析失败：${(e as Error).message}`);
  }

  const sections = splitSections(content);
  for (const key of REQUIRED_SECTIONS) {
    if (!sections[key]) {
      throw new ProfileError(key, `缺 ## ${key} 小节`);
    }
  }

  const merged = {
    ...data,
    description: sections.description,
    personality: sections.personality,
    speechStyle: sections.speechStyle,
    scenario: sections.scenario,
    dialogueExamples: parseDialogueExamples(sections.dialogueExamples),
    ...(sections.secrets ? { secrets: sections.secrets } : {}),
  };

  const result = residentProfileSchema.safeParse(merged);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const field = issue.path.join('.') || 'unknown';
    throw new ProfileError(field, issue.message);
  }
  const profile = result.data;

  // 地点合法性（home / haunts / schedule.location 都须在地点清单内）
  if (!isLocation(profile.home)) {
    throw new ProfileError('home', `「${profile.home}」不在地点清单：${LOCATIONS.join('、')}`);
  }
  for (const haunt of profile.haunts) {
    if (!isLocation(haunt)) {
      throw new ProfileError('haunts', `「${haunt}」不在地点清单`);
    }
  }
  for (const [i, block] of profile.schedule.entries()) {
    if (!isLocation(block.location)) {
      throw new ProfileError('schedule', `第 ${i + 1} 个时间块的地点「${block.location}」不在地点清单`);
    }
  }

  return profile;
}

export interface LoadProfilesResult {
  profiles: ResidentProfile[];
  /** 被拒绝的档案：id → 错误（含字段信息） */
  rejected: { id: string; error: ProfileError }[];
}

/**
 * 从 D1 载入全部档案：逐份解析 + 护栏检查。
 * 不合法的档案被拒绝（不载入）并记录原因，不拖垮其余档案（F2）。
 */
export async function loadAll(db: D1Database): Promise<LoadProfilesResult> {
  const { results } = await db
    .prepare('SELECT id, raw FROM profiles ORDER BY id')
    .all<{ id: string; raw: string }>();

  const profiles: ResidentProfile[] = [];
  const rejected: LoadProfilesResult['rejected'] = [];

  for (const row of results) {
    try {
      // 护栏先行：注入残留等直接拒载
      const guardResult = await check(db, row.raw, 'profile', row.id);
      if (guardResult !== 'ok') {
        throw new ProfileError('guard', guardResult.reason);
      }
      profiles.push(parseProfile(row.raw));
    } catch (e) {
      rejected.push({
        id: row.id,
        error: e instanceof ProfileError ? e : new ProfileError('unknown', (e as Error).message),
      });
    }
  }

  return { profiles, rejected };
}

/** 发布用：写入/更新一份档案原文 */
export async function upsertProfileRow(
  db: D1Database,
  id: string,
  raw: string,
  ts: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO profiles (id, raw, updated_ts) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET raw = excluded.raw, updated_ts = excluded.updated_ts`,
    )
    .bind(id, raw, ts)
    .run();
}
