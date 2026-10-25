import { register } from 'node:module';
import { randomUUID } from 'node:crypto';

register('./ts-resolver.mjs', import.meta.url);

const apiKey = process.env.GROQ_LLM_API_KEY;
if (!apiKey) {
  console.error('GROQ_LLM_API_KEY is required to run the live memory experiment.');
  process.exitCode = 1;
} else {
  const [{ runAbMemoryExperiment }, { OpenAiLlmGateway }, { applyOps }] = await Promise.all([
    import('../packages/engine/src/llm/index.ts'),
    import('../packages/engine/src/llm/client.ts'),
    import('../packages/engine/src/domain/index.ts'),
  ]);
  const models = (process.env.GROQ_LLM_MODELS ?? 'llama-3.3-70b-versatile')
    .split(',').map((model) => model.trim()).filter(Boolean);
  const settings = {
    models,
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey,
    segmentWorldMinutes: 60,
    minIntervalSeconds: 0,
    hourlyLimit: 40,
    dailyLimit: 200,
    concurrency: 2,
  };
  const calls = new Map();
  const auditStore = {
    async createCall(call) { calls.set(call.id, structuredClone(call)); },
    async updateCall(id, patch) {
      const call = calls.get(id);
      if (call) calls.set(id, { ...call, ...structuredClone(patch) });
    },
  };
  const gateway = new OpenAiLlmGateway(settings, auditStore, { createId: () => `ab_${randomUUID()}` });
  const initialWorld = {
    premise: 'Two neighbors share a village but remember a past disagreement differently.',
    entities: {
      ada: { kind: 'character', name: 'Ada', location: 'village' },
      bo: { kind: 'character', name: 'Bo', location: 'village' },
      village: { kind: 'place', name: 'Village' },
      well: { kind: 'place', name: 'Old well', location: 'village' },
    },
  };
  try {
    const report = await runAbMemoryExperiment({
      initialWorld,
      gateway,
      runsPerArm: Number(process.env.AB_MEMORY_BEATS ?? 3),
      applyEvent(world, event) {
        return event.ops.length ? applyOps(world, event.ops).world : world;
      },
    });
    const usage = {
      calls: calls.size,
      requests: [...calls.values()].reduce((sum, call) => sum + call.attempts.length, 0),
      totalTokens: [...calls.values()].reduce((sum, call) => sum + (call.usage?.totalTokens ?? 0), 0),
    };
    process.stdout.write(`${JSON.stringify({ report, usage }, null, 2)}\n`);
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'Error';
    console.error(`Live A/B experiment failed (${errorName}).`);
    process.exitCode = 1;
  }
}
