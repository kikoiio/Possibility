// src/world/chapter.ts — 章节总结：每积累一段条目浓缩为一章
// 章节的持续追加 = 故事的前情提要 = 最终的故事概览版本。

import { z } from 'zod';
import { check } from '../feed/guard';
import { structured, type LlmContext } from '../llm/client';
import { insertChapter, latestChapter, listEntriesAfter } from '../store/db';

const chapterSchema = z.object({
  title: z.string().describe('章节标题，10 字以内，有小说感'),
  content: z.string().describe('章节概要，200-400 字'),
});

/**
 * 章节触发与生成。
 * 条件：自上一章以来条目数 >= chapterEveryEntries；
 * 或跨天且条目数 >= 8（每天至少要能收出一章）。
 */
export async function maybeWriteChapter(ctx: LlmContext): Promise<boolean> {
  const db = ctx.env.DB;
  const last = await latestChapter(db);
  const sinceTs = last?.toTs ?? 0;
  const material = await listEntriesAfter(db, sinceTs, 100);

  const threshold = ctx.config.chapterEveryEntries;
  const crossedDay =
    last !== null &&
    new Date(material.at(-1)?.ts ?? 0).toDateString() !== new Date(last.toTs).toDateString();
  if (material.length < threshold && !(crossedDay && material.length >= 8)) {
    return false;
  }

  const story = material
    .map((e) => {
      const time = new Date(e.ts).toLocaleString('zh-CN', {
        month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
      });
      return `[${time}] ${e.title ? `【${e.title}】` : ''}${e.content}`;
    })
    .join('\n\n');

  const chapter = await structured(ctx, 'chapter', 'prose', chapterSchema, [
    {
      role: 'system',
      content:
        '你是临海商店街这部连载小说的编辑。把下面这一段连续发生的故事浓缩成一章：' +
        '起一个 10 字以内、有小说感的章节标题，再写 200-400 字的章节概要。' +
        '概要要有叙事感（起因、经过、小小的波澜与落点），不要流水账，' +
        '要能让刚来的读者快速接住前情。简体中文。',
    },
    { role: 'user', content: story },
  ]);

  if ((await check(db, `${chapter.title}\n${chapter.content}`, 'entry', null)) !== 'ok') {
    return false;
  }

  await insertChapter(db, {
    ts: Date.now(),
    title: chapter.title,
    content: chapter.content,
    fromTs: material[0]!.ts,
    toTs: material.at(-1)!.ts,
  });
  return true;
}
