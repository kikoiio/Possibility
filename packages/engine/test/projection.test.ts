import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { WorldState } from '@wispiva/contract';
import { projectWorld } from '../src/projection/index.js';

const openFieldsFixture = JSON.parse(readFileSync(new URL('../../contract/fixtures/world-open-fields.json', import.meta.url), 'utf8')) as { world: WorldState };
const goldenFixture = JSON.parse(readFileSync(new URL('../../contract/fixtures/renderer-view-golden.json', import.meta.url), 'utf8')) as { world: WorldState; view: { places: unknown[]; characters: unknown[]; others: unknown[] } };

describe('projectWorld', () => {
  it('projects fixture entities with defaults and keeps unknown kinds in others', () => {
    const { view } = projectWorld(openFieldsFixture.world, 0, 'rev-fixture', null);
    expect(view.revisionId).toBe('rev-fixture');
    expect(view.characters.map(({ id, locationId }) => ({ id, locationId }))).toEqual([{ id: '老舟', locationId: '书院' }]);
    expect(view.others.map(({ id, kind }) => ({ id, kind }))).toContainEqual({ id: '潮汐钟', kind: 'tidal-clock' });
    expect(view.places.find(node => node.id === '书院')).toMatchObject({ width: 1, depth: 1, height: 1 });
  });

  it('matches the renderer fixture categorization and remains pure', () => {
    const world = structuredClone(goldenFixture.world);
    const before = structuredClone(world);
    const { view, scene } = projectWorld(world, 480, 'rev_origin_village', '清晨的潮气漫过村中石板路。');
    expect(view).toEqual({ ...goldenFixture.view, recentText: '清晨的潮气漫过村中石板路。' });
    expect(scene.schemaVersion).toBe(1);
    expect(scene.objects.map(object => object.kind)).toEqual(expect.arrayContaining(['library', 'porch', 'bridge', 'character']));
    expect(world).toEqual(before);
  });

  it('places every unrecognized entity kind into others', () => {
    const world: WorldState = { entities: {
      probe: { kind: 'clockwork-beast', x: 4, z: 2 },
      marsh: { kind: 'water', center: [1, 2], size: [50, 40], elevation: -1 },
      isle: { kind: 'island', center: [1, 2], radius: 10, elevation: 0.6, irregularity: 0.08 },
    } };
    const result = projectWorld(world, 8, 'rev', null);
    expect(result.view.others).toMatchObject([{ id: 'probe', kind: 'clockwork-beast', x: 4, z: 2 }]);
    expect(result.scene.regions).toEqual(expect.arrayContaining([
      { id: 'marsh', kind: 'water', center: [1, 2], size: [50, 40], elevation: -1 },
      { id: 'isle', kind: 'island', center: [1, 2], radius: 10, elevation: 0.6, irregularity: 0.08 },
    ]));
  });
});
