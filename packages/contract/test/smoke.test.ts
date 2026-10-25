import { describe, expect, it } from 'vitest';
import opSchema from '../src/schemas/op.schema.json' with { type: 'json' };
import planSchema from '../src/schemas/plan.schema.json' with { type: 'json' };
import proposalSchema from '../src/schemas/edit-proposal.schema.json' with { type: 'json' };

// 冒烟:三个 schema 可加载、是 2020-12、关键约束存在。
// fixtures 的全量校验测试由 fixtures.test.ts(随 fixtures 一起提交)负责。
describe('contract schemas', () => {
  it('three schemas load with 2020-12 dialect', () => {
    for (const schema of [opSchema, planSchema, proposalSchema]) {
      expect(schema.$schema).toContain('2020-12');
    }
  });

  it('op schema forbids value on remove and requires it on set', () => {
    const allOf = JSON.stringify(opSchema.allOf);
    expect(allOf).toContain('"const":"set"');
    expect(allOf).toContain('"const":"remove"');
    expect(allOf).toContain('"not"');
  });

  it('memory def enforces owner rows with emotion vocabulary', () => {
    const memory = (planSchema.$defs as Record<string, unknown>).memory as Record<string, unknown>;
    const required = memory.required as string[];
    for (const field of ['owner', 'valence', 'intensity', 'importance', 'about']) {
      expect(required).toContain(field);
    }
    expect(JSON.stringify(memory.properties)).toContain('恐惧');
  });

  it('edit proposal schema refs op and memory definitions', () => {
    expect(JSON.stringify(proposalSchema.properties)).toContain('op.schema.json');
    expect(JSON.stringify(proposalSchema.properties)).toContain('memory');
  });
});
