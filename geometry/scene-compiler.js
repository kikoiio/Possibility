import { buildSolid } from './solid.js';
import { buildVoxel } from './voxel.js';
import { validateSceneDocument, validateSpatialLayout, formatDiagnostic, sceneLayout, islandContains } from './scene-document.js';
import { batchStaticMeshes } from './primitives.js';
import { validateCompiledSpatial } from './compiled-spatial.js';
import { buildCamp } from './camp-compiler.js';

const basePartIds = ['terrain', 'library', 'interior', 'porch', 'bridge', 'nature'];
export function partIdsFor(document) {
  if (document?.profile === 'beast-camp') return document.objects.map(node => `camp:${node.id}`);
  const ids = [...basePartIds];
  for (const object of document?.objects ?? []) {
    if (object?.kind === 'house' && object.id) ids.push(`house:${object.id}`);
    if (object?.kind === 'room' && object.id) ids.push(`room:${object.id}`);
    if (object?.kind === 'path' && object.id) ids.push(`path:${object.id}`);
    if (object?.kind === 'character' && object.id) ids.push(`character:${object.id}`);
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
function validate(document, backend) {
  const errors = validateSceneDocument(document);
  if (!['solid', 'voxel'].includes(backend)) errors.push({ nodeId: document?.id || 'document', operationId: 'compile', requirementId: 'backend.kind', message: `未知后端 ${backend}` });
  if (document?.profile === 'beast-camp' && backend !== 'solid') errors.push({ nodeId: document.id, operationId: 'compile', requirementId: 'camp.backend', message: 'beast-camp profile 当前仅支持 solid；尚未实现营地 voxel 后端' });
  if (!errors.length) errors.push(...validateSpatialLayout(document));
  if (errors.length) throw new SceneCompileError(errors);
}
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function recipeHashes(document, backend, options) {
  if (document.profile === 'beast-camp') return Object.fromEntries(document.objects.map(node => [`camp:${node.id}`, stable([backend, document.profile, document.style, node])]));
  const layout = sceneLayout(document);
  const recipes = {
    terrain: [document.regions, options.details],
    library: [layout.library, options.cutaway],
    interior: layout.library,
    porch: [layout.porch, options.edited],
    bridge: [layout.bridge, options.edited],
    nature: [layout.trees, layout.islands[0], layout.water, options.details],
  };
  for (const object of document?.objects ?? []) {
    if (object?.kind === 'house' && object.id) recipes[`house:${object.id}`] = [object];
    if (object?.kind === 'room' && object.id) recipes[`room:${object.id}`] = [object];
    if (object?.kind === 'path' && object.id) recipes[`path:${object.id}`] = [object, hostIslandOf(document, object)];
    if (object?.kind === 'character' && object.id) recipes[`character:${object.id}`] = [object];
  }
  // Canonical recipe content is retained, not a lossy 32-bit identity. It also makes differences inspectable.
  return Object.fromEntries(partIdsFor(document).map(id => [id, stable([backend, document.style, recipes[id]])]));
}
export function disposePart(part) {
  const geometries = new Set(), ownedMaterials = new Set();
  part.traverse(node => {
    if (!node.geometry) return;
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
function buildParts(document, backend, options, parts, hashes) {
  const camp = document.profile === 'beast-camp';
  const build = backend === 'solid' ? buildSolid : buildVoxel;
  const result = camp ? buildCamp(document, parts) : build(options.materials, options.edited, options.details, options.cutaway, document, { parts });
  try {
    for (const [id, part] of Object.entries(result.userData.parts)) {
      if (!camp) batchStaticMeshes(part);
      part.userData.recipeHash = hashes[id];
      part.userData.partId = id;
    }
    const errors = validateCompiledSpatial(document, result.userData.parts);
    if (errors.length) throw new SceneCompileError(errors);
    return result;
  } catch (error) {
    disposeWorld(result);
    throw error;
  }
}
export function compileScene(document, backend, options = {}) {
  validate(document, backend);
  const hashes = recipeHashes(document, backend, options);
  const world = buildParts(document, backend, options, partIdsFor(document), hashes);
  world.userData.sceneId = document.id;
  world.userData.profile = document.profile;
  world.userData.backend = backend;
  world.userData.materials = options.materials;
  world.userData.recipeHashes = hashes;
  world.userData.rebuiltParts = partIdsFor(document);
  return world;
}
export function compileSceneParts(document, backend, options, requestedParts = []) {
  if (!options.world) return compileScene(document, backend, options);
  return prepareSceneUpdate(document, backend, options, requestedParts).commit();
}

export function prepareSceneUpdate(document, backend, options, requestedParts = []) {
  const world = options.world;
  if (!world) return compileScene(document, backend, options);
  validate(document, backend);
  if (world.userData.backend !== backend) throw new Error('增量编译不能更换后端');
  if (world.userData.profile !== document.profile) throw new Error('增量编译不能更换 profile');
  for (const id of requestedParts) if (!partIdsFor(document).includes(id)) throw new Error(`未知 partId=${id}`);
  const hashes = recipeHashes(document, backend, options);
  // A request is a hint; content dependencies determine the actual dirty set, including scene edits.
  const dirty = partIdsFor(document).filter(id => hashes[id] !== world.userData.recipeHashes[id] || options.materials !== world.userData.materials);
  // Objects removed from the document drop their parts entirely.
  const stale = Object.keys(world.userData.parts).filter(id => !hashes[id]);
  const replacement = buildParts(document, backend, options, dirty, hashes);
  let pending = true;
  return {
    cancel() { if (pending) { disposeWorld(replacement); pending = false; } },
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
