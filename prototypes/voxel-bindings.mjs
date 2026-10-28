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
