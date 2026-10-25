import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Memory, Op, Plan, WorldState } from '@wispiva/contract';
import { applyOps, validateMemories, validatePlan, validateWorld } from '../src/domain/index.js';

const fixtureDirectory = fileURLToPath(new URL('../../contract/fixtures/', import.meta.url));

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(`${fixtureDirectory}/${name}`, 'utf8')) as unknown;
}

function collectObjects(value: unknown, predicate: (candidate: Record<string, unknown>) => boolean): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap((item) => collectObjects(item, predicate));
  if (value === null || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  return [ ...(predicate(record) ? [record] : []), ...Object.values(record).flatMap((item) => collectObjects(item, predicate)) ];
}

function hasWorldShape(value: Record<string, unknown>): boolean {
  return value.entities !== null && typeof value.entities === 'object' && !Array.isArray(value.entities);
}

function hasPlanShape(value: Record<string, unknown>): boolean {
  return typeof value.fromMinutes === 'number' && Array.isArray(value.events) && typeof value.callId === 'string';
}

describe('domain operations', () => {
  it('rejects every invalid operation with its fixture diagnostic', () => {
    const fixture = readFixture('ops-invalid.json') as { world: WorldState; ops: Op[]; expectedErrors: string[] };
    fixture.ops.forEach((op, index) => {
      expect(() => applyOps(fixture.world, [op])).toThrow(fixture.expectedErrors[index]);
    });
  });

  it('keeps the input world unchanged when a batch contains an invalid operation', () => {
    const fixture = readFixture('ops-invalid.json') as { world: WorldState; ops: Op[] };
    const before = structuredClone(fixture.world);
    expect(() => applyOps(fixture.world, [
      { op: 'set', path: '/entities/书院/open', value: false },
      fixture.ops[0] as Op,
    ])).toThrow();
    expect(fixture.world).toEqual(before);
  });

  it('applies valid changes to a deep copy and reports paths in order', () => {
    const fixture = readFixture('origin-revision.json') as { world: WorldState };
    const result = applyOps(fixture.world, [
      { op: 'set', path: '/entities/书院/open', value: true },
      { op: 'set', path: '/entities/老舟/location', value: '木桥' },
    ]);
    expect(result.changes).toEqual(['/entities/书院/open', '/entities/老舟/location']);
    expect(fixture.world.entities['书院']?.open).toBeUndefined();
    expect(result.world.entities['老舟']?.location).toBe('木桥');
  });
});

describe('domain invariants', () => {
  const fixtureNames = readdirSync(fixtureDirectory).filter((name) => name.endsWith('.json'));
  const fixtureValues = fixtureNames.map((name) => [name, readFixture(name)] as const);

  it('accepts every valid world found in contract fixtures', () => {
    const worlds = fixtureValues.flatMap(([name, value]) => collectObjects(value, hasWorldShape).map((world) => ({ name, world })));
    expect(worlds.length).toBeGreaterThan(0);
    for (const { name, world } of worlds) {
      expect(validateWorld(world as unknown as WorldState), `${name}: ${JSON.stringify(world)}`).toEqual([]);
    }
  });

  it('accepts every valid plan found in contract fixtures', () => {
    const plans = fixtureValues.flatMap(([name, value]) => collectObjects(value, hasPlanShape).map((plan) => ({ name, plan })));
    expect(plans.length).toBeGreaterThan(0);
    for (const { name, plan } of plans) {
      const fixtureWorld = collectObjects(readFixture(name), hasWorldShape)[0] as unknown as WorldState | undefined;
      expect(fixtureWorld, `${name} must include a world fixture`).toBeDefined();
      expect(validatePlan(fixtureWorld as WorldState, plan as unknown as Plan), `${name}: ${JSON.stringify(plan)}`).toEqual([]);
    }
  });

  it('checks memory references and score ranges', () => {
    const fixture = readFixture('world-open-fields.json') as { world: WorldState; memoryWithoutOptionalEmotion: Memory };
    expect(validateMemories(fixture.world, [fixture.memoryWithoutOptionalEmotion])).toEqual([]);
  });
});
