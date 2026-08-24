// scripts/live-llm-check.ts — 活体检查：真实 DeepSeek 验证生成路径
// 用法：先在项目根目录创建 .dev.vars 填入 LLM_API_KEY，然后
//   pnpm exec tsx scripts/live-llm-check.ts
// 不经过 D1（用量记录已在单测覆盖），验证：
// 1) key 可用  2) 文本生成  3) 结构化输出（Output.object）与 DeepSeek 兼容

import { createDeepSeek } from '@ai-sdk/deepseek';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { readFileSync } from 'node:fs';

function loadDevVars(path: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) vars[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return vars;
}

const apiKey = loadDevVars('.dev.vars').LLM_API_KEY;
if (!apiKey) {
  console.error('✗ .dev.vars 里缺少 LLM_API_KEY（格式：LLM_API_KEY=sk-...）');
  process.exit(1);
}

const deepseek = createDeepSeek({ apiKey });
const model = deepseek('deepseek-chat');

console.log('1) 文本生成...');
const t = await generateText({ model, prompt: '用一句中文说早安，不超过 15 字。' });
console.log('   ✓', t.text);
console.log('   usage:', JSON.stringify(t.usage));

console.log('2) 结构化生成（zod 校验）...');
const o = await generateText({
  model,
  prompt: '输出 JSON：{"location":"满月喫茶","activity":"烘豆"}',
  output: Output.object({
    schema: z.object({ location: z.string(), activity: z.string() }),
  }),
});
console.log('   ✓', JSON.stringify(o.output));

console.log('\n全部通过：DeepSeek 与本项目的文本/结构化生成路径兼容。');
