import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import opSchema from '../src/schemas/op.schema.json' with { type: 'json' };
import planSchema from '../src/schemas/plan.schema.json' with { type: 'json' };
import proposalSchema from '../src/schemas/edit-proposal.schema.json' with { type: 'json' };

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8')) as T;
const schemaValidator = new Ajv2020({ allErrors: true, strict: false });
schemaValidator.addSchema(opSchema);
schemaValidator.addSchema(opSchema, 'op.schema.json');
schemaValidator.addSchema(opSchema, 'wispiva/contract/op.schema.json');
schemaValidator.addSchema(planSchema);
schemaValidator.addSchema(planSchema, 'plan.schema.json');
schemaValidator.addSchema(planSchema, 'wispiva/contract/plan.schema.json');
schemaValidator.addSchema(proposalSchema);
const validatePlan = schemaValidator.getSchema('wispiva/contract/plan')!;
const validateOp = schemaValidator.getSchema('wispiva/contract/op')!;
type MemoryFixture = { owner: string; about: string[]; valence: number; intensity: number; importance: number };
type EventFixture = { atMinutes: number; memories: MemoryFixture[] };
type PlanFixture = { events: EventFixture[] };
type AcceptedPlanFixture = { after: { line: { plan: PlanFixture } } };
type DueCommitFixture = { committedRevisions: { worldTimeMinutes: number; event: { atMinutes: number; memories?: MemoryFixture[] } }[] };

function semanticOpError(op: Record<string, unknown>, world: { entities: Record<string, Record<string, unknown>> }): string | undefined {
  const path = op.path as string;
  const segments = path.slice(1).split('/').map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (segments.some((segment) => ['__proto__', 'prototype', 'constructor'].includes(segment))) return '原型污染敏感路径';
  if (op.op === 'set' && segments.at(-1) === 'location' && typeof op.value === 'string' && !(op.value in world.entities)) return 'location 引用不存在的实体';
  if (op.op === 'remove') {
    let current: unknown = world;
    for (const segment of segments) {
      if (!current || typeof current !== 'object' || !(segment in current)) return 'remove 目标不存在';
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return undefined;
}

describe('contract fixtures', () => {
  it('validates accepted and due plans against the Plan schema', () => {
    const accepted = fixture<{ after: { line: { plan: unknown } } }>('plan-accepted');
    const due = fixture<{ plan: unknown }>('plan-due-commit');
    const fork = fixture<{ plan: unknown }>('fork-confirm');
    expect(validatePlan(accepted.after.line.plan), JSON.stringify(validatePlan.errors)).toBe(true);
    expect(validatePlan(due.plan), JSON.stringify(validatePlan.errors)).toBe(true);
    expect(validatePlan(fork.plan), JSON.stringify(validatePlan.errors)).toBe(true);
  });

  it('validates the confirmed edit proposal and audit operations', () => {
    const fork = fixture<{ editProposal: unknown }>('fork-confirm');
    expect(schemaValidator.validate('wispiva/contract/edit-proposal', fork.editProposal), JSON.stringify(schemaValidator.errors)).toBe(true);
    const audit = fixture<{ calls: { ops: unknown[] }[] }>('llm-call-audit');
    for (const call of audit.calls) for (const op of call.ops) expect(validateOp(op), JSON.stringify(validateOp.errors)).toBe(true);
  });

  it('rejects each invalid operation with its matching expected error', () => {
    const invalid = fixture<{ world: { entities: Record<string, Record<string, unknown>> }; ops: Record<string, unknown>[]; expectedErrors: string[] }>('ops-invalid');
    expect(invalid.ops).toHaveLength(invalid.expectedErrors.length);
    const reasons = invalid.ops.map((op) => {
      return semanticOpError(op, invalid.world) ?? (!validateOp(op) ? 'schema' : undefined);
    });
    expect(reasons.every(Boolean)).toBe(true);
    expect(reasons).toHaveLength(invalid.expectedErrors.length);
    expect(invalid.expectedErrors).toEqual([
      'set 操作缺少必需的 value。',
      'path 含有无效的 JSON Pointer 转义序列 ~2。',
      'path 指向原型污染敏感键 __proto__。',
      'location 值引用了不存在的实体“不存在的渡口”。',
      'remove 目标 /entities/木桥 在当前世界中不存在。',
      'remove 操作禁止携带 value。'
    ]);
  });

  it('checks origin, memory ownership, minute integers, and open world fields', () => {
    const origin = fixture<{ parentId: string | null; worldTimeMinutes: number; event: { atMinutes: number }; world: { premise: unknown } }>('origin-revision');
    expect(origin.parentId).toBeNull();
    expect(origin.world.premise).toBeDefined();
    expect(Number.isInteger(origin.worldTimeMinutes)).toBe(true);
    expect(Number.isInteger(origin.event.atMinutes)).toBe(true);

    const accepted = fixture<AcceptedPlanFixture>('plan-accepted');
    const due = fixture<DueCommitFixture>('plan-due-commit');
    const memories = [...accepted.after.line.plan.events.flatMap((event) => event.memories), ...due.committedRevisions.flatMap((revision) => revision.event.memories ?? [])];
    for (const memory of memories) {
      expect(memory.owner.length).toBeGreaterThan(0);
      expect(memory.about.length).toBeGreaterThan(0);
      expect(memory.valence).toBeGreaterThanOrEqual(-1);
      expect(memory.valence).toBeLessThanOrEqual(1);
      expect(memory.intensity).toBeGreaterThanOrEqual(0);
      expect(memory.intensity).toBeLessThanOrEqual(1);
      expect(Number.isInteger(memory.importance)).toBe(true);
      expect(memory.importance).toBeGreaterThanOrEqual(1);
      expect(memory.importance).toBeLessThanOrEqual(10);
    }
    for (const revision of due.committedRevisions) {
      expect(Number.isInteger(revision.worldTimeMinutes)).toBe(true);
      expect(Number.isInteger(revision.event.atMinutes)).toBe(true);
    }
    const openWorld = fixture<{ world: { entities: Record<string, { kind: string }>; extensions: { emptyAboutProbe: { about: unknown[] } } }; memoryWithoutOptionalEmotion: Record<string, unknown> }>('world-open-fields');
    expect(openWorld.world.entities['潮汐钟']!.kind).toBe('tidal-clock');
    expect(openWorld.world.extensions.emptyAboutProbe.about).toEqual([]);
    expect(openWorld.memoryWithoutOptionalEmotion).not.toHaveProperty('emotion');
    expect(openWorld.memoryWithoutOptionalEmotion).toHaveProperty('owner');
    expect(openWorld.memoryWithoutOptionalEmotion).toHaveProperty('about');
  });

  it('checks renderer defaults, fork changes, and SSE snapshot alignment', () => {
    const renderer = fixture<{ view: { places: unknown[]; characters: Record<string, unknown>[]; others: Record<string, unknown>[] }; defaults: Record<string, number> }>('renderer-view-golden');
    expect(renderer.view.places.length).toBeGreaterThan(0);
    expect(renderer.view.characters.some((character) => character.locationId === '书院')).toBe(true);
    expect(renderer.view.others[0]).toMatchObject({ width: renderer.defaults['榕树.width'], depth: renderer.defaults['榕树.depth'], height: renderer.defaults['榕树.height'] });
    const fork = fixture<{ editProposal: { changedPaths: string[] }; result: { revision: { event: { atMinutes: number; changes: string[] } }; line: { forkTimeMinutes: number } } }>('fork-confirm');
    expect(fork.result.revision.event.changes).toEqual(fork.editProposal.changedPaths);
    expect(Number.isInteger(fork.result.revision.event.atMinutes)).toBe(true);
    expect(fork.result.line.forkTimeMinutes).toBe(fork.result.revision.event.atMinutes);
    const snapshot = fixture<{ snapshot: { lines: { worldTimeMinutes: number }[]; views: Record<string, { worldTimeMinutes: number }>; recentLogs: Record<string, { event: { atMinutes: number } }[]> }; replay: { type: string }[] }>('sse-reconnect-snapshot');
    expect(snapshot.snapshot.views.line_alpha!.worldTimeMinutes).toBe(snapshot.snapshot.lines[0]!.worldTimeMinutes);
    expect(snapshot.snapshot.recentLogs.line_alpha!.every((entry) => Number.isInteger(entry.event.atMinutes))).toBe(true);
    expect(snapshot.replay[0]!.type).toBe('line');
  });
});
