import { libraryScene } from './scene-document.js';

// Unfamiliar dimensions, IDs, translation and heading expose accidental demo coordinates.
export function createUnfamiliarScene() {
  const document = structuredClone(libraryScene);
  document.id = 'rotated-marsh-observatory';
  document.title = '转向湿地阅览站';
  const [library, porch, bridge] = document.objects;
  Object.assign(library.bounds, { width: 10.8, depth: 8.4, wallHeight: 5.5 });
  Object.assign(library.entrance, { width: 3.1, height: 4.1 });
  Object.assign(porch.bounds, { width: 7.8, depth: 3.3 });
  porch.transform.position[2] = 5.7;
  document.regions[1].radius = 14;
  document.regions[2].center = [18, 7];
  document.regions[2].radius = 5.5;
  bridge.from.point = [9, 0.9, 4.5];
  bridge.to.point = [18, 0.9, 7];
  bridge.width = 2.7;
  bridge.segments = 17;
  document.objects.at(-1).position = [18, 0.61, 4.2];
  Object.assign(document.objects.find(o => o.id === 'tree-west'), { position: [-8, 0.8, 4], scale: 0.4 });
  const angle = 0.6;
  const move = ([x, y, z]) => [30 + x * Math.cos(angle) + z * Math.sin(angle), y + 1, -20 - x * Math.sin(angle) + z * Math.cos(angle)];
  const ids = new Map([...document.regions, ...document.objects].map(node => [node.id, `new-${node.id}`]));
  for (const region of document.regions) {
    const [x, , z] = move([region.center[0], 0, region.center[1]]);
    region.center = [x, z];
    region.elevation += 1;
    region.id = ids.get(region.id);
  }
  for (const object of document.objects) {
    object.id = ids.get(object.id);
    if (object.transform) { object.transform.position = move(object.transform.position); object.transform.rotation = angle; }
    if (object.position) object.position = move(object.position);
    for (const endpoint of [object.from, object.to].filter(Boolean)) { endpoint.point = move(endpoint.point); endpoint.region = ids.get(endpoint.region); }
    for (const attachment of object.attachments || []) attachment.target = ids.get(attachment.target);
  }
  return document;
}
