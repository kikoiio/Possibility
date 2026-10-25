import { buildSolid } from './solid.js';
import { validateSceneDocument, validateSpatialLayout, formatDiagnostic, sceneLayout, islandContains } from './scene-document.js';
import { batchStaticMeshes } from './primitives.js';

const basePartIds = ['terrain', 'library', 'interior', 'porch', 'bridge', 'nature'];
export function partIdsFor(document) {
  const ids = [...basePartIds];
  for (const object of document?.objects ?? []) {
    if (['house', 'path', 'character'].includes(object?.kind) && object.id) ids.push(`${object.kind}:${object.id}`);
  }
  return ids;
}
function hostIslandOf(document, path) {
  const point = path?.points?.[0];
  if (!point) return null;
  return (document?.regions ?? []).find(region => region?.kind === 'island' && islandContains(region, point[0], point[1])) ?? null;
}
export class SceneCompileError extends Error {
  constructor(diagnostics) {
    super(diagnostics.map(formatDiagnostic).join('\n'));
    this.name = 'SceneCompileError';
    this.diagnostics = diagnostics;
  }
}
function validate(document) {
  const errors = validateSceneDocument(document);
  if (!errors.length) errors.push(...validateSpatialLayout(document));
  if (errors.length) throw new SceneCompileError(errors);
}
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function recipeHashes(document, options) {
  const layout = sceneLayout(document);
  const recipes = {
    terrain: [document.regions, options.details], library: [layout.library, options.cutaway],
    interior: layout.library, porch: [layout.porch, options.edited], bridge: [layout.bridge, options.edited],
    nature: [layout.trees, layout.islands[0], layout.water, options.details],
  };
  for (const object of document?.objects ?? []) {
    if (object?.kind === 'house' && object.id) recipes[`house:${object.id}`] = [object];
    if (object?.kind === 'path' && object.id) recipes[`path:${object.id}`] = [object, hostIslandOf(document, object)];
    if (object?.kind === 'character' && object.id) recipes[`character:${object.id}`] = [object];
  }
  return Object.fromEntries(partIdsFor(document).map(id => [id, stable([document.style, recipes[id]])]));
}
export function disposePart(part) {
  const geometries = new Set(), ownedMaterials = new Set();
  part.traverse(node => {
    if (!node.isMesh) return;
    geometries.add(node.geometry);
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) if (material.userData.ownedByPart) ownedMaterials.add(material);
    if (node.isInstancedMesh) node.dispose();
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of ownedMaterials) material.dispose();
}
export function disposeWorld(world) {
  for (const part of Object.values(world.userData.parts)) disposePart(part);
  world.removeFromParent();
}
function buildParts(document, options, selected, hashes) {
  const result = buildSolid(options.materials, options.edited, options.details, options.cutaway, document, { parts: selected });
  try {
    for (const [id, part] of Object.entries(result.userData.parts)) {
      batchStaticMeshes(part);
      part.userData.recipeHash = hashes[id];
      part.userData.partId = id;
    }
    return result;
  } catch (error) {
    disposeWorld(result);
    throw error;
  }
}
export function compileScene(document, backend, options) {
  if (backend !== 'solid') throw new Error(`未知或不支持的后端 ${backend}`);
  validate(document);
  const hashes = recipeHashes(document, options);
  const ids = partIdsFor(document);
  const world = buildParts(document, options, ids, hashes);
  world.userData.sceneId = document.id;
  world.userData.backend = 'solid';
  world.userData.materials = options.materials;
  world.userData.recipeHashes = hashes;
  world.userData.rebuiltParts = ids;
  return world;
}
export function prepareSceneUpdate(document, backend, options, requestedParts = []) {
  if (backend !== 'solid') throw new Error(`未知或不支持的后端 ${backend}`);
  const world = options.world;
  if (!world) return { rebuiltParts: partIdsFor(document), commit: () => compileScene(document, backend, options), cancel() {} };
  validate(document);
  if (world.userData.backend !== 'solid') throw new Error('增量编译不能更换后端');
  for (const id of requestedParts) if (!partIdsFor(document).includes(id)) throw new Error(`未知 partId=${id}`);
  const hashes = recipeHashes(document, options);
  const ids = partIdsFor(document);
  const dirty = ids.filter(id => hashes[id] !== world.userData.recipeHashes[id] || options.materials !== world.userData.materials);
  const stale = Object.keys(world.userData.parts).filter(id => !hashes[id]);
  const replacement = buildParts(document, options, dirty, hashes);
  let pending = true;
  return {
    rebuiltParts: dirty,
    cancel() {
      if (pending) { disposeWorld(replacement); pending = false; }
    },
    commit() {
      if (!pending) throw new Error('增量事务已经结束');
      pending = false;
      for (const id of [...dirty, ...stale]) {
        const old = world.userData.parts[id];
        if (!old) continue;
        old.removeFromParent();
        disposePart(old);
        delete world.userData.parts[id];
      }
      for (const id of dirty) {
        world.add(replacement.userData.parts[id]);
        world.userData.parts[id] = replacement.userData.parts[id];
      }
      world.userData.sceneId = document.id;
      world.userData.recipeHashes = hashes;
      world.userData.materials = options.materials;
      world.userData.rebuiltParts = dirty;
      return world;
    },
  };
}
