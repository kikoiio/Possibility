"""Pure, bounded genesis-to-Luanti plan compiler. No engine or filesystem access."""
from __future__ import annotations

import copy
import json

from .genesis import validate

# Compatible with the current agent's default horizontal bounds and spawn height;
# the caller must explicitly configure the runtime to match these values.
BOUND = 32
GRID_SPACING = 8
SPAWN_Y = 1
SLOT_OFFSETS = tuple((x, z) for z in (-2, -1, 0, 1, 2) for x in (-2, -1, 0, 1, 2))


class CompileError(ValueError):
    def __init__(self, code, diagnostics=()):
        super().__init__(code)
        self.code = code
        self.diagnostics = list(diagnostics)


def compile_plan(draft):
    """Return a fresh JSON-compatible plan; it contains private actor data."""
    try:
        # A JSON round trip prevents aliases, non-JSON objects and non-finite numbers.
        source = json.loads(json.dumps(draft, ensure_ascii=False, allow_nan=False))
        errors = validate(source)
    except (ValueError, TypeError, OverflowError, RecursionError, AttributeError):
        raise CompileError('invalid_draft') from None
    if errors:
        raise CompileError('invalid_draft', errors)
    if not 1 <= len(source['actors']) <= 64:
        raise CompileError('actor_count')

    # IDs are already validated as restricted ASCII identifiers, never paths.
    layout = {p['placeId']: p for p in source['layout']['places']}
    places = []
    for place in sorted(source['places'], key=lambda p: p['id']):
        item = layout[place['id']]
        gx, gz = item['grid']
        x, z = gx * GRID_SPACING, gz * GRID_SPACING
        if abs(x) > BOUND or abs(z) > BOUND:
            raise CompileError('out_of_bounds', [{'path': '$.layout.places', 'code': 'place_out_of_bounds'}])
        places.append({'id': place['id'], 'name': place['name'], 'space': item['space'],
                       'grid': [gx, gz], 'anchor': {'x': x, 'y': SPAWN_Y, 'z': z}})
    by_place = {p['id']: p for p in places}
    actors = sorted(source['actors'], key=lambda a: a['id'])
    occupants = {}
    public_actors, private_actors, occupied = [], {}, set()
    for ordinal, actor in enumerate(actors):
        place = by_place[actor['placeId']]
        slot = occupants.get(place['id'], 0)
        occupants[place['id']] = slot + 1
        if slot >= len(SLOT_OFFSETS):
            raise CompileError('place_actor_capacity', [{'path': '$.actors', 'code': 'too_many_actors_at_place'}])
        dx, dz = SLOT_OFFSETS[slot]
        position = {'x': place['anchor']['x'] + dx, 'y': SPAWN_Y, 'z': place['anchor']['z'] + dz}
        if abs(position['x']) > BOUND or abs(position['z']) > BOUND:
            raise CompileError('out_of_bounds', [{'path': '$.actors', 'code': 'spawn_out_of_bounds'}])
        point = (position['x'], position['y'], position['z'])
        if point in occupied:
            raise CompileError('spatial_conflict', [{'path': '$.actors', 'code': 'spawn_collision'}])
        occupied.add(point)
        public_actors.append({'actor_id': actor['id'], 'ordinal': ordinal, 'name': actor['name'],
                              'place_id': place['id'], 'grid': place['grid'][:], 'position': position})
        private_actors[actor['id']] = {'role': actor['role'], 'goal': actor['goal'],
                                         'memory_seeds': [m['text'] for m in source['memories'] if m['actorId'] == actor['id']]}

    connections = sorted(({'from': min(c['from'], c['to']), 'to': max(c['from'], c['to'])}
                          for c in source['layout']['connections']), key=lambda c: (c['from'], c['to']))
    return {
        'schema_version': 1,
        'public': {'title': source['title'], 'bounds': {'min': {'x': -BOUND, 'y': SPAWN_Y, 'z': -BOUND},
                    'max': {'x': BOUND, 'y': SPAWN_Y, 'z': BOUND}},
                   'grid_spacing': GRID_SPACING, 'places': places, 'actors': public_actors,
                   'semantic_connections': connections},
        'private_actors': private_actors,
        'unsupported': ([{'code': 'descriptive_rule_not_executed', 'rule_id': r['id']}
                         for r in sorted(source['rules'], key=lambda r: r['id'])] +
                        [{'code': 'luanti_map_not_integrated'}, {'code': 'terrain_and_spawn_safety_unverified'},
                         {'code': 'semantic_connections_not_paths'}, {'code': 'character_runtime_not_integrated'}]),
    }


def public_plan(plan):
    """Copy only the compiler's public section; never return the private actor map."""
    return copy.deepcopy(plan['public'])
