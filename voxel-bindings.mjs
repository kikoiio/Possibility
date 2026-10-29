// The simulation keeps its narrative places and the voxel view as two views of
// one origin. These bindings give both views stable semantic anchors without
// making the renderer invent a second scene or forcing generated-world's
// existing scene validator to accept arbitrary voxel geometry.

const clone = value => structuredClone(value);
const normalize = value => String(value ?? '').trim().toLocaleLowerCase().replace(/[\s_\-:.,，。/\\]+/g, '');

function anchorFor(object, fallback) {
  const from = object?.from ?? fallback.min;
  const to = object?.to ?? fallback.max;
  const position = [
    (from[0] + to[0] + 1) / 2,
    from[1] + 0.8,
    (from[2] + to[2] + 1) / 2,
  ];
  return {
    id: object?.id ?? 'voxel-world',
    name: object?.name ?? '体素场景',
    kind: object?.kind ?? 'scene',
    bounds: { from: [...from], to: [...to] },
    position,
  };
}

function voxelBounds(cells) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const { position } of cells) for (let axis = 0; axis < 3; axis++) {
    min[axis] = Math.min(min[axis], position[axis]);
    max[axis] = Math.max(max[axis], position[axis]);
  }
  return { min, max };
}

/**
 * Build stable semantic links for a generated world's places and actors.
 * Matching prefers exact ids, then names, then deterministic order. The
 * resulting positions are informational anchors for the voxel presentation;
 * the simulation still owns actor location and movement through place ids.
 */
export function bindVoxelWorld({ definition, voxel }) {
  const cells = Array.isArray(voxel?.cells) ? voxel.cells : [];
  const objects = Array.isArray(voxel?.objects) ? voxel.objects : [];
  const places = Array.isArray(definition?.world?.places) ? definition.world.places : [];
  const actors = Array.isArray(definition?.world?.actors) ? definition.world.actors : [];
  if (!cells.length) return { version: 1, anchors: [], places: [], actors: [] };

  const fallback = voxelBounds(cells);
  const anchors = (objects.length ? objects : [null]).map(object => anchorFor(object, fallback));
  const unused = new Set(anchors.map((_, index) => index));
  const choose = (place, placeIndex) => {
    const exactId = anchors.findIndex((anchor, index) => unused.has(index) && anchor.id === place.id);
    if (exactId >= 0) return exactId;
    const placeName = normalize(place.name);
    const nameMatch = anchors.findIndex((anchor, index) => unused.has(index) && normalize(anchor.name) === placeName);
    if (nameMatch >= 0) return nameMatch;
    const ordered = [...unused][placeIndex] ?? [...unused][0];
    return ordered === undefined ? placeIndex % anchors.length : ordered;
  };
  const placeBindings = places.map((place, placeIndex) => {
    const anchorIndex = choose(place, placeIndex);
    unused.delete(anchorIndex);
    const anchor = anchors[anchorIndex];
    return { placeId: place.id, anchorId: anchor.id, position: [...anchor.position] };
  });
  const actorBindings = actors.map(actor => ({
    actorId: actor.id,
    placeId: actor.location,
    anchorId: placeBindings.find(binding => binding.placeId === actor.location)?.anchorId ?? anchors[0].id,
  }));
  return { version: 1, anchors: clone(anchors), places: placeBindings, actors: actorBindings };
}

// A visible person requires an unambiguous place match and two empty cells of
// headroom. Unknown spatial ownership is left unplaced rather than guessed.
export function projectVoxelActors({ world, voxel }) {
  if (!Array.isArray(voxel?.cells) || !Array.isArray(voxel.objects)) return [];
  const cells = new Map(voxel.cells.map(c => [c.position.join(','), c.material]));
  return (world?.actors || []).flatMap(actor => {
    const place = world.places.find(p => p.id === actor.location);
    if (!place) return [];
    const exact = voxel.objects.filter(o => o.id === place.id);
    const matches = exact.length ? exact : voxel.objects.filter(o => normalize(o.name) === normalize(place.name));
    if (matches.length !== 1) return [];
    const object = matches[0], center = object.from.map((n, i) => (n + object.to[i] + 1) / 2);
    const supports = voxel.cells.filter(c => !['water', 'leaves', 'glass'].includes(c.material) && c.position.every((n, i) => n >= object.from[i] && n <= object.to[i]))
      .map(c => c.position).filter(([x, y, z]) => !cells.has([x, y + 1, z].join(',')) && !cells.has([x, y + 2, z].join(',')) && y + 2 <= object.to[1])
      .sort((a, b) => (a[1] - b[1]) || (Math.hypot(a[0] + 0.5 - center[0], a[2] + 0.5 - center[2]) - Math.hypot(b[0] + 0.5 - center[0], b[2] + 0.5 - center[2])));
    if (!supports.length) return [];
    const [x, y, z] = supports[0];
    return [{ id: actor.id, name: actor.name, placeId: place.id, position: [x + 0.5, y + 1, z + 0.5] }];
  });
}
