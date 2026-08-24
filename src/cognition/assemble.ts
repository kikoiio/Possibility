// src/cognition/assemble.ts — 分层注入组装器
// 层序（SillyTavern 生态验证的位置模型）：
//   system   人格锚（稳定内容，远离生成点也不漂移）
//   user     世界状态块
//   user     预算化记忆块
//   user     当前情境
//   user     depth-0 任务指令 + 风格锚（贴生成点，防人格漂移）

import type { ModelMessage } from 'ai';
import type { ResidentProfile } from '../persona/profile';
import type { MemoryEntry } from '../store/db';
import type { WorldView } from '../world/types';

export interface AssembleInput {
  profile: ResidentProfile;
  world: WorldView;
  /** 已按相关度排序的记忆（从头部取，超预算从尾部丢弃） */
  memories: MemoryEntry[];
  /** 当前情境（如"你刚到堤坝，看到七濑也在"） */
  situation: string;
  /** depth-0 任务指令（如"决定你下一步的行动"） */
  instruction: string;
  /** 记忆 token 预算（默认 800） */
  memoryTokenBudget?: number;
}

/** 中文 token 粗估：1 token ≈ 1.5 字 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 1.5);
}

function personaAnchor(profile: ResidentProfile): string {
  const examples =
    profile.dialogueExamples.length > 0
      ? `\n【对话示例】\n${profile.dialogueExamples.map((e) => `- ${e}`).join('\n')}`
      : '';
  return (
    `你是${profile.name}，${profile.age}岁，${profile.role}。\n\n` +
    `【性格】${profile.personality}\n\n` +
    `【背景】${profile.description}\n\n` +
    `【说话方式】${profile.speechStyle}\n` +
    examples +
    `\n\n你生活在临海商店街小镇，始终以${profile.name}的身份思考与说话，` +
    `绝不暴露自己是 AI 或程序。输出为简体中文。`
  );
}

function worldBlock(world: WorldView): string {
  const coPresent = world.coPresent.length > 0 ? world.coPresent.join('、') : '只有你自己';
  const events = world.events.length > 0 ? `\n发生的事：${world.events.join('；')}` : '';
  return (
    `【世界】现在是 ${world.localTime}（${world.period}），${world.season}，天气：${world.weather}。\n` +
    `你在${world.location}。在场的人：${coPresent}。` +
    events
  );
}

/** 预算化记忆块：从头取到预算耗尽；返回拼好的块文本 */
export function memoryBlock(memories: MemoryEntry[], tokenBudget: number): string {
  if (memories.length === 0) return '【你记得的事】（暂无）';
  const lines: string[] = [];
  let used = 0;
  for (const m of memories) {
    const line = `- ${m.content}`;
    const cost = estimateTokens(line);
    if (used + cost > tokenBudget) break;
    lines.push(line);
    used += cost;
  }
  return `【你记得的事】\n${lines.join('\n')}`;
}

function styleReminder(profile: ResidentProfile): string {
  // 风格锚：取说话方式的首句作为贴生成点的提醒
  const first = profile.speechStyle.split(/[。！？\n]/)[0]?.trim() ?? profile.speechStyle;
  return first.length > 60 ? `${first.slice(0, 60)}…` : first;
}

export function assemble(input: AssembleInput): ModelMessage[] {
  const { profile, world, situation, instruction } = input;
  const budget = input.memoryTokenBudget ?? 800;

  return [
    { role: 'system', content: personaAnchor(profile) },
    { role: 'user', content: worldBlock(world) },
    { role: 'user', content: memoryBlock(input.memories, budget) },
    { role: 'user', content: `【现在的情境】${situation}` },
    {
      role: 'user',
      content: `【任务】${instruction}\n（记住：你是${profile.name}。${styleReminder(profile)}）`,
    },
  ];
}
