"""Offline v1 origin-to-model slice; it is not connected to Luanti.

The caller must authenticate and authorize the principal for the actor and
obtain the binding from trusted persisted state. Equality checks here are not
authentication, authorization, proof of persistence, or proof that caller-supplied
observations, messages and feedback are true or suitable for this recipient.
Free text in the allowed fields must itself be authorized by the caller.
Local action candidates are caller claims from a sampled state, not proof of
reachability. A real executor must revalidate the action against current state.

Binding fields: contract_version, world_id, origin_event_id, draft_sha256,
actor_id, runtime_ids (the complete persisted mapping), and luanti_id. Luanti's
temporary zero-based ID is the saved runtime_id minus one, never a new ranking.
Inputs have exact schemas; no caller-defined fields are forwarded.
"""
import json
import math
import re

from model import adapter
from world.origin import OriginError, origin_snapshot
from world.origin_view import initial_self_context

MAX_ITEMS = 32
MAX_TEXT_BYTES = 512
MAX_CONTEXT_BYTES = 16000  # ASCII JSON, as encoded by adapter.decide
MAX_COORD = 1000000
MAX_MEMORY_ITEMS = 8
MAX_MEMORY_BYTES = 4096


class ContextError(ValueError):
    """Invalid binding, input schema or budget; no model call was made."""


def _fields(value, required, optional=()):
    if (type(value) is not dict or not set(required) <= value.keys()
            or not value.keys() <= set(required) | set(optional)):
        raise ContextError('invalid fields')


def _integer(value, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise ContextError('invalid integer')
    return value


def _text(value):
    if not isinstance(value, str) or not value.strip():
        raise ContextError('invalid text')
    try:
        if len(value.encode('utf-8')) > MAX_TEXT_BYTES:
            raise ContextError('text too large')
    except UnicodeError:
        raise ContextError('invalid text') from None
    return value


def _point(value):
    _fields(value, ('x', 'y', 'z'))
    return {axis: _integer(value[axis], -MAX_COORD, MAX_COORD) for axis in ('x', 'y', 'z')}


def _position(value):
    _fields(value, ('x', 'y', 'z'))
    result = {}
    for axis in ('x', 'y', 'z'):
        coordinate = value[axis]
        if (type(coordinate) not in (int, float) or not -MAX_COORD <= coordinate <= MAX_COORD
                or not math.isfinite(coordinate)):
            raise ContextError('invalid position')
        result[axis] = coordinate
    return result


def _list(value):
    if type(value) is not list or len(value) > MAX_ITEMS:
        raise ContextError('invalid list')
    return value


def _bound_origin(event, binding):
    _fields(binding, ('contract_version', 'world_id', 'origin_event_id',
                      'draft_sha256', 'actor_id', 'runtime_ids', 'luanti_id'))
    if type(binding['contract_version']) is not int or binding['contract_version'] != 1:
        raise ContextError('invalid binding version')
    try:
        world, actors = origin_snapshot(event, binding['world_id'])
        self_context = initial_self_context(event, binding['world_id'], binding['actor_id'])
    except (OriginError, TypeError):
        raise ContextError('invalid origin or actor') from None
    for key in ('actor_id', 'name', 'role', 'goal', 'initial_place_id'):
        _text(self_context[key])
    for memory in _list(self_context['memories']):
        _text(memory['seed_id'])
        _text(memory['text'])
        _text(memory['source']['event_id'])
    saved = world['origin']['runtime_ids']
    supplied = binding['runtime_ids']
    if (type(supplied) is not dict or supplied.keys() != saved.keys()
            or any(type(supplied[key]) is not int or supplied[key] != value
                   for key, value in saved.items())
            or binding['origin_event_id'] != event['id']
            or binding['draft_sha256'] != event['data']['draft_sha256']
            or type(binding['luanti_id']) is not int
            or binding['luanti_id'] != actors[binding['actor_id']]['runtime_id'] - 1):
        raise ContextError('binding mismatch')
    return self_context, saved


def _memory_context(self_context, binding, query, max_entries, max_bytes):
    if query != '':
        _text(query)
    elif type(query) is not str:
        raise ContextError('invalid query')
    _integer(max_entries, 0, MAX_MEMORY_ITEMS)
    _integer(max_bytes, 2, MAX_MEMORY_BYTES)
    terms = set(re.findall(r'\w+', query.casefold()))
    records = []
    for seed in self_context['memories']:
        records.append({
            'world_id': binding['world_id'], 'seed_id': seed['seed_id'],
            'owner': self_context['actor_id'], 'text': seed['text'],
            'source': {**seed['source'], 'id': seed['seed_id']},
            'known_by': [self_context['actor_id']], 'classification': 'unknown',
            'time': None, 'importance': None,
        })
    ranked = sorted(enumerate(records), key=lambda item: (
        -len(terms & set(re.findall(r'\w+', item[1]['text'].casefold()))), item[0]))
    selected, used = [], 2  # The complete compact JSON array, including brackets.
    for index, record in ranked:
        if len(selected) == max_entries:
            break
        cost = len(json.dumps(record, ensure_ascii=True, sort_keys=True,
                              separators=(',', ':')).encode('ascii')) + bool(selected)
        if used + cost <= max_bytes:
            selected.append((index, record))
            used += cost
    selected.sort(key=lambda item: item[0])
    memories = [record for _, record in selected]
    return {'memory': memories, 'memory_query': query,
            'memory_scope': {'mode': 'genesis.lexical', 'world_id': binding['world_id'],
                             'owner': self_context['actor_id'], 'available': len(records),
                             'selected': len(memories), 'omitted': len(records) - len(memories),
                             'bytes': used, 'max_entries': max_entries, 'max_bytes': max_bytes}}


def retrieve_genesis_memories(event, binding, *, query='', max_entries=MAX_MEMORY_ITEMS,
                             max_bytes=MAX_MEMORY_BYTES):
    """Retrieve private seeds from a manifest's trusted genesis.created payload.

    The manifest loader supplies the persisted event and binding, not a public
    draft or an arbitrary actor profile. Matching is lexical, with original seed
    order breaking ties; no match falls back to that order. Selected records
    retain seed order. Knowledge is restricted to the owner, truth classification
    is unknown, and absent occurrence time/importance remain None. These records
    are model context, not fabricated L0 facts or writes to the L1/L2 store.
    """
    self_context, _ = _bound_origin(event, binding)
    return _memory_context(self_context, binding, query, max_entries, max_bytes)


def build_manifest_context(manifest, binding, local, *, memory_query='',
                           max_memory_entries=MAX_MEMORY_ITEMS,
                           max_memory_bytes=MAX_MEMORY_BYTES):
    """Project one actor from trusted persisted creation materials.

    Only origin_event is consumed; projection/confirmation and other all-actor
    materials never enter the prompt. The loader still authenticates the file
    and verifies the complete manifest; this checks its envelope and binding.
    """
    if (type(manifest) is not dict
            or manifest.get('format') != 'wispiva-world-creation-materials'
            or type(manifest.get('version')) is not int or manifest['version'] != 1
            or 'origin_event' not in manifest or type(binding) is not dict
            or not isinstance(manifest.get('world_id'), str)
            or manifest['world_id'] != binding.get('world_id')):
        raise ContextError('invalid creation manifest')
    return build_context(manifest['origin_event'], binding, local,
                         memory_query=memory_query, max_memory_entries=max_memory_entries,
                         max_memory_bytes=max_memory_bytes)


def build_context(event, binding, local, *, memory_query='',
                  max_memory_entries=MAX_MEMORY_ITEMS, max_memory_bytes=MAX_MEMORY_BYTES):
    """Validate and compose a detached adapter context from trusted inputs.

    local requires observation {has_target, nearby_agents}, bounds {min,max},
    incoming_messages [{sender_id,text}], and feedback [{kind,success}].
    observation may also contain pos. IDs in these fields are zero-based Luanti
    IDs from the persisted mapping; message text and feedback are caller claims.
    Optional local_actions has gather_points and build_points, plus optional
    reach, movement and sensing fields with the action_context fixed values.
    memory_query selects this actor's seeds; an empty query uses the private goal.
    Omitted records are counted, and the legacy self.memories mirrors only the
    selected seeds, so it cannot bypass the retrieval limits.
    """
    self_context, saved = _bound_origin(event, binding)
    memory_context = _memory_context(self_context, binding,
                                     self_context['goal'] if memory_query == '' else memory_query,
                                     max_memory_entries, max_memory_bytes)
    selected_ids = {record['seed_id'] for record in memory_context['memory']}
    self_context['memories'] = [seed for seed in self_context['memories']
                                if seed['seed_id'] in selected_ids]

    _fields(local, ('observation', 'bounds', 'incoming_messages', 'feedback'), ('local_actions',))
    observation = local['observation']
    _fields(observation, ('has_target', 'nearby_agents'), ('pos',))
    if type(observation['has_target']) is not bool:
        raise ContextError('invalid observation')
    known = {runtime_id - 1 for runtime_id in saved.values()}
    others = known - {binding['luanti_id']}
    nearby = [_integer(item, 0, len(saved) - 1) for item in _list(observation['nearby_agents'])]
    if len(set(nearby)) != len(nearby) or not set(nearby) <= others:
        raise ContextError('invalid nearby agents')
    obs = {'has_target': observation['has_target'], 'nearby_agents': nearby}
    if 'pos' in observation:
        obs['pos'] = _position(observation['pos'])
    bounds = local['bounds']
    _fields(bounds, ('min', 'max'))
    bounds = {side: _point(bounds[side]) for side in ('min', 'max')}
    if any(bounds['min'][axis] > bounds['max'][axis] for axis in ('x', 'y', 'z')):
        raise ContextError('invalid bounds')
    local_actions = None
    if 'local_actions' in local:
        actions = local['local_actions']
        _fields(actions, ('gather_points', 'build_points'), ('reach', 'movement', 'sensing'))
        fixed = {'reach': 1.5,
                 'movement': 'wander or approach sets a destination; advance moves toward it',
                 'sensing': 'local radius, no line-of-sight occlusion; sampled state can change'}
        for key, expected in fixed.items():
            if key in actions and (type(actions[key]) is not type(expected) or actions[key] != expected):
                raise ContextError('invalid local actions')
        local_actions = {key: [_point(point) for point in _list(actions[key])]
                         for key in ('gather_points', 'build_points')}
        for points in local_actions.values():
            if any(not all(bounds['min'][axis] <= point[axis] <= bounds['max'][axis]
                           for axis in ('x', 'y', 'z')) for point in points):
                raise ContextError('candidate out of bounds')
        local_actions.update({key: fixed[key] for key in fixed if key in actions})
    messages = []
    for message in _list(local['incoming_messages']):
        _fields(message, ('sender_id', 'text'))
        sender = _integer(message['sender_id'], 0, len(saved) - 1)
        if sender not in others:
            raise ContextError('invalid sender')
        messages.append({'sender_id': sender, 'text': _text(message['text'])})
    feedback = []
    for item in _list(local['feedback']):
        _fields(item, ('kind', 'success'))
        if item['kind'] not in ('inspect', 'mark', 'advance', 'approach', 'wander', 'say', 'gather', 'build') or type(item['success']) is not bool:
            raise ContextError('invalid feedback')
        feedback.append({'kind': item['kind'], 'success': item['success']})
    context = {'contract_version': 1, 'world_id': binding['world_id'],
               'origin_event_id': event['id'], 'draft_sha256': event['data']['draft_sha256'],
               'self_id': binding['luanti_id'], 'self': self_context,
               'observation': obs, 'bounds': bounds,
               'incoming_messages': messages, 'feedback': feedback}
    context.update(memory_context)
    if local_actions is not None:
        context['local_actions'] = local_actions
    try:
        encoded = json.dumps(context, ensure_ascii=True, sort_keys=True,
                             separators=(',', ':'), allow_nan=False).encode('ascii')
    except (TypeError, ValueError, UnicodeError):
        raise ContextError('invalid context') from None
    if len(encoded) > MAX_CONTEXT_BYTES:
        raise ContextError('context too large')
    return context


def decide(config, event, binding, local, *, transport=None, memory_query='',
           max_memory_entries=MAX_MEMORY_ITEMS, max_memory_bytes=MAX_MEMORY_BYTES):
    """Validate, invoke the adapter, and restrict resource actions to candidates.

    Candidate membership is not an execution guarantee; the executor must
    revalidate reachability, resources, inventory, and world state at execution.
    """
    context = build_context(event, binding, local, memory_query=memory_query,
                            max_memory_entries=max_memory_entries,
                            max_memory_bytes=max_memory_bytes)
    if transport is None:
        result = adapter.decide(config, context)
    else:
        result = adapter.decide(config, context, transport=transport)
    action = result['action']
    if action['kind'] in ('gather', 'build'):
        candidates = context.get('local_actions', {}).get(action['kind'] + '_points', [])
        if action['point'] not in candidates:
            raise adapter.ModelError('invalid_action', audit=result['audit'])
    return result
