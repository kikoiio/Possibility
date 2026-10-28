import { validateSceneDocument, validateSpatialLayout } from './scene-document.js';
// Use the very same geometry checks as a renderer projection, for every possible
// destination, including currently unoccupied places. No alternative tolerances.
export function validateWorldBindings(world, scene) {
  if (world?.profile !== 'generated-world') return [];
  const diagnostic = (id, message) => ({ nodeId: id, operationId: 'bind-world-scene', requirementId: 'world.binding', message });
  if (scene?.profile !== 'world') return [diagnostic('scene', '生成世界需要对应的 world 场景文档。')];
  const base = validateSceneDocument(scene);
  if (base.length) return base;
  const characters = scene.objects.filter(object => object.kind === 'character');
  if (characters.length !== world.actors.length || world.actors.some(actor => characters.filter(object => object.id === actor.id).length !== 1)) return [diagnostic('scene', '三维人物必须与世界人物身份一一对应。')];
  const errors = [];
  const nonCharacters = scene.objects.filter(object => object.kind !== 'character');
  for (const [i, place] of world.places.entries()) {
    let id = `binding-probe-${i}`;
    while (nonCharacters.some(object => object.id === id)) id += '-x';
    const character = { id, kind: 'character', name: place.name, position: place.position };
    if (place.roomId !== undefined) character.roomId = place.roomId;
    const probe = { ...scene, objects: [...nonCharacters, character] };
    const structural = validateSceneDocument(probe);
    const failed = structural.length ? structural : validateSpatialLayout(probe);
    for (const error of failed) errors.push({ ...error, nodeId: place.id, operationId: 'bind-world-scene', message: `地点“${place.name}”不能供居民抵达：${error.message}` });
  }
  return errors;
}
