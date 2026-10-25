// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createMaterials } from '../src/renderers/3d/materials.js';
import { compileScene, disposeWorld, prepareSceneUpdate } from '../src/renderers/3d/scene-compiler.js';
import { villageScene } from '../src/renderers/3d/scene-document.js';
import type { SceneDocument } from '../src/renderers/3d/scene-document.js';

function stats(root: THREE.Object3D) {
  let triangles = 0, meshCount = 0;
  root.traverse(node => {
    if (!node.userData || !(node as THREE.Mesh).isMesh) return;
    const mesh = node as THREE.Mesh | THREE.InstancedMesh;
    meshCount++;
    const instanceCount = mesh instanceof THREE.InstancedMesh ? mesh.count : 1;
    triangles += (mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count) / 3 * instanceCount;
  });
  return { triangles: Math.round(triangles), meshCount };
}

describe('solid renderer', () => {
  it('compiles deterministic geometry and snapshots part and triangle counts', () => {
    const world = compileScene(villageScene, 'solid', { materials: createMaterials(), details: true, edited: false, cutaway: false });
    expect(Object.keys(world.userData.parts)).toMatchSnapshot();
    expect(stats(world)).toMatchSnapshot();
    disposeWorld(world);
  });

  it('rebuilds only the edited house recipe', () => {
    const materials = createMaterials();
    const document = structuredClone(villageScene) as SceneDocument;
    const world = compileScene(document, 'solid', { materials, details: true, edited: false, cutaway: false });
    const house = document.objects.find(object => object.id === 'h2')!;
    (house as unknown as { roof: { rise: number } }).roof.rise += 0.2;
    const update = prepareSceneUpdate(document, 'solid', { materials, details: true, edited: false, cutaway: false, world });
    expect(update.rebuiltParts).toEqual(['house:h2']);
    expect(update.commit()).toBe(world);
    expect(world.userData.rebuiltParts).toEqual(['house:h2']);
    disposeWorld(world);
    for (const material of Object.values(materials)) material.dispose();
  });
});
