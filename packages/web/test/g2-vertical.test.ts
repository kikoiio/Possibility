// @vitest-environment node
// 门 G2 竖切:store → runtime(mock beat)→ revision → projection → 3D 编译 → 增量重建。
// 浏览器可见的实时推进冒烟按资源规则延后到云端 CI / 内存充裕时本机执行。
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Plan, Revision, WorldLine, WorldState } from '@wispiva/contract';
import { openStore, type Store } from '../../engine/src/store/index.js';
import { Runtime } from '../../engine/src/runtime/index.js';
import { projectWorld } from '../../engine/src/projection/index.js';
import type { LlmGateway, LlmSettings } from '../../engine/src/llm/index.js';
import { createMaterials } from '../src/renderers/3d/materials.js';
import { compileScene, disposeWorld, prepareSceneUpdate } from '../src/renderers/3d/scene-compiler.js';
import type { SceneDocument } from '../src/renderers/3d/scene-document.js';

const golden = JSON.parse(
  readFileSync(new URL('../../contract/fixtures/renderer-view-golden.json', import.meta.url), 'utf8'),
) as { world: WorldState };
const settings: LlmSettings = {
  models: ['test'], baseUrl: 'http://localhost', apiKey: '', segmentWorldMinutes: 60,
  minIntervalSeconds: 0, hourlyLimit: 40, dailyLimit: 200, concurrency: 2,
};
const gateway: LlmGateway = {
  beat: async input => ({
    callId: 'call_beat',
    plan: { fromMinutes: input.worldTimeMinutes, toMinutes: input.worldTimeMinutes + 60, events: [], callId: 'call_beat' },
  }),
  edit: async input => ({
    schemaVersion: 1, proposalId: 'call_edit', draftId: input.draftId, baseRevisionId: input.baseRevisionId,
    ops: [], summary: 'noop', changedPaths: [], memories: [],
  }),
};

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('G2 vertical slice', () => {
  it('runs a beat into the world and renders it incrementally in 3D', async () => {
    await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
    const dir = await mkdtemp(join(process.cwd(), '.tmp/g2-'));
    tempDirs.push(dir);
    const store: Store = await openStore(join(dir, 'g2.sqlite'));

    const world: WorldState = structuredClone(golden.world);
    const origin: Revision = {
      id: 'rev_origin', parentId: null, worldTimeMinutes: 0,
      event: { id: 'evt_origin', kind: 'origin', text: '芦汀渔村醒来。', atMinutes: 0 }, world,
    };
    const plan: Plan = {
      fromMinutes: 0, toMinutes: 60, callId: 'call_seed', events: [{
        id: 'evt_move', atMinutes: 1, text: '老舟走向石板路尽头。',
        ops: [{ op: 'set', path: '/entities/老舟/x', value: 3.5 }],
        memories: [{
          id: 'mem_1', owner: '阿苇', text: '老舟朝村口去了。',
          valence: -0.4, intensity: 0.5, importance: 6, about: ['老舟'], emotion: '恐惧',
        }],
      }],
    };
    const line: WorldLine = {
      id: 'line', name: 'α', parentLineId: null, forkRevisionId: null, forkTimeMinutes: null,
      headRevisionId: origin.id, worldTimeMinutes: 0, speed: 24, paused: false, plan,
      status: 'ready', error: null, retryAt: 0,
    };
    await store.createLine(line);
    await store.appendRevisions(line.id, [origin]);

    let now = 0;
    const runtime = new Runtime({ store, gateway, settings, projectWorld, now: () => now });
    await runtime.tick();          // 建立时钟锚点
    now = 3_000;                   // 24×:3 真实秒 = 1.2 世界分钟,evt_move 到期
    await runtime.tick();

    const head = (await store.getLine('line'))!;
    expect(head.worldTimeMinutes).toBeGreaterThanOrEqual(1);
    const entries = (await store.pageLog('line', { limit: 10 })).entries;
    expect(entries.map(entry => entry.event.id)).toContain('evt_move');
    expect((await store.getMemories('line', ['阿苇'], 10))).toHaveLength(1);

    const headRevision = (await store.getRevision(head.headRevisionId))!;
    expect((headRevision.world.entities['老舟'] as { x?: number }).x).toBe(3.5);

    const { scene, view } = projectWorld(headRevision.world, head.worldTimeMinutes, head.headRevisionId, '老舟走向石板路尽头。');
    expect(view.characters.some(character => character.id === '老舟')).toBe(true);
    const document = scene as SceneDocument;
    expect(document.objects.some(object => object.kind === 'library')).toBe(true);

    const materials = createMaterials();
    const rendered = compileScene(document, 'solid', { materials, details: true, edited: false, cutaway: false });
    const before = { triangles: 0 };
    rendered.traverse(node => {
      const mesh = node as { isMesh?: boolean; geometry?: { index?: { count: number } | null; attributes?: { position?: { count: number } } } };
      if (!mesh.isMesh) return;
      before.triangles += (mesh.geometry!.index?.count ?? mesh.geometry!.attributes!.position!.count) / 3;
    });
    expect(before.triangles).toBeGreaterThan(1_000);

    const moved = structuredClone(document);
    const laozhou = moved.objects.find(object => object.id === '老舟') as unknown as { position: [number, number, number] };
    laozhou.position = [3.5, laozhou.position[1], laozhou.position[2] + 1];
    const update = prepareSceneUpdate(moved, 'solid', { materials, details: true, edited: false, cutaway: false, world: rendered });
    expect(update.rebuiltParts).toEqual(['character:老舟']);
    update.commit();
    disposeWorld(rendered);
    for (const material of Object.values(materials)) material.dispose();
    await runtime.close();
  });
});
