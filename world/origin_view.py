"""Narrow initial self-context projection; authorization belongs to the caller.

This is not an observation of the current world and does not authenticate the
requesting actor. The caller must bind actor_id to an authorized principal and
must not expose the origin event or full snapshots to model-facing consumers.
"""
from copy import deepcopy

from world.origin import OriginError, origin_snapshot


def initial_self_context(event, world_id, actor_id):
    """Return only one actor's initial identity, goal, and sourced seed memories.

    Reconstructing from the validated origin makes ownership derive from the
    confirmed draft rather than untrusted request fields. No other actors,
    world descriptions, rules, resource state, or raw event are projected.
    """
    _, actors = origin_snapshot(event, world_id)
    if not isinstance(actor_id, str) or actor_id not in actors:
        raise OriginError('unknown actor')
    actor = actors[actor_id]
    return deepcopy({
        'actor_id': actor_id,
        'name': actor['name'],
        'role': actor['role'],
        'goal': actor['goal'],
        'initial_place_id': actor['place_id'],
        'memories': actor['memory_seeds'],
    })
