"""Pure v1 origin prototype; not connected to WorldStore, genesis, or a runtime.

Confirmation and operation binding must be authenticated and persisted by the caller.
Origin events and snapshots contain private data and are not public projections.
"""
from __future__ import annotations

import copy
import hashlib
import uuid

from genesis.genesis import MAX_OUTPUT, validate
from genesis.store import _encode


class OriginError(ValueError):
    """An origin input or persisted origin event violates the v1 contract."""


def _fields(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise OriginError('invalid fields')


def _text(value):
    if not isinstance(value, str) or not value.strip():
        raise OriginError('invalid identifier')
    try:
        value.encode('utf-8')
    except UnicodeError:
        raise OriginError('invalid identifier') from None


def validate_world_id(world_id):
    """Require a canonical UUID; allocation and uniqueness belong to the caller."""
    try:
        if not isinstance(world_id, str) or str(uuid.UUID(world_id)) != world_id:
            raise ValueError
    except (ValueError, AttributeError):
        raise OriginError('invalid world_id') from None
    return world_id


def draft_sha256(draft):
    """Validate and hash exactly the encoding used by the existing draft store."""
    try:
        errors = validate(draft)
        if errors or not draft['actors']:
            raise OriginError('invalid draft')
        encoded = _encode(draft).encode('utf-8')
        if len(encoded) > MAX_OUTPUT:
            raise OriginError('invalid draft')
    except (TypeError, ValueError, UnicodeError, RecursionError, KeyError) as exc:
        if isinstance(exc, OriginError):
            raise
        raise OriginError('invalid draft') from None
    return hashlib.sha256(encoded).hexdigest()


def _validate_mapping(draft, mapping):
    ids = {actor['id'] for actor in draft['actors']}
    if (not isinstance(mapping, dict) or set(mapping) != ids
            or any(type(value) is not int for value in mapping.values())
            or set(mapping.values()) != set(range(1, len(ids) + 1))):
        raise OriginError('invalid runtime_ids')


def create_origin_event(world_id, confirmed):
    """Construct an event from a caller-verified, bound confirmation record.

    Record fields are draft_id, draft_revision, draft_sha256, operation_id,
    status (exactly 'confirmed'), and draft. This function cannot verify that a
    user confirmed it or that the binding was persisted.
    """
    validate_world_id(world_id)
    _fields(confirmed, ('draft_id', 'draft_revision', 'draft_sha256',
                        'operation_id', 'status', 'draft'))
    _text(confirmed['draft_id'])
    _text(confirmed['operation_id'])
    if confirmed['status'] != 'confirmed':
        raise OriginError('draft not confirmed')
    if type(confirmed['draft_revision']) is not int or confirmed['draft_revision'] < 1:
        raise OriginError('invalid draft revision')
    digest = draft_sha256(confirmed['draft'])
    if confirmed['draft_sha256'] != digest:
        raise OriginError('draft digest mismatch')
    ids = sorted(actor['id'] for actor in confirmed['draft']['actors'])
    origin = {'draft': copy.deepcopy(confirmed['draft']),
              'runtime_ids': {ident: i for i, ident in enumerate(ids, 1)},
              'coordinate_system': 'fake-grid-v1'}
    return {'id': confirmed['operation_id'], 'type': 'genesis.created',
            'data': {'contract_version': 1, 'world_id': world_id,
                     'draft_id': confirmed['draft_id'],
                     'draft_revision': confirmed['draft_revision'],
                     'draft_sha256': digest, 'origin': origin}}


def origin_snapshot(event, world_id):
    """Validate a persisted origin event and derive detached world/character snapshots.

    The persisted mapping is authoritative; it is validated as a bijection and
    never reallocated during replay. No authorization or public view is provided.
    """
    validate_world_id(world_id)
    _fields(event, ('id', 'type', 'data'))
    _text(event['id'])
    if event['type'] != 'genesis.created':
        raise OriginError('invalid event type')
    data = event['data']
    _fields(data, ('contract_version', 'world_id', 'draft_id', 'draft_revision',
                   'draft_sha256', 'origin'))
    if type(data['contract_version']) is not int or data['contract_version'] != 1:
        raise OriginError('invalid contract version')
    if data['world_id'] != world_id:
        raise OriginError('world_id mismatch')
    _text(data['draft_id'])
    if type(data['draft_revision']) is not int or data['draft_revision'] < 1:
        raise OriginError('invalid draft revision')
    origin = data['origin']
    _fields(origin, ('draft', 'runtime_ids', 'coordinate_system'))
    if origin['coordinate_system'] != 'fake-grid-v1':
        raise OriginError('invalid coordinate system')
    if draft_sha256(origin['draft']) != data['draft_sha256']:
        raise OriginError('draft digest mismatch')
    _validate_mapping(origin['draft'], origin['runtime_ids'])
    world = {'contract_version': 1, 'world_id': world_id, 'origin_event_id': event['id'],
             'origin': copy.deepcopy(origin), 'resources': None}
    characters = {}
    for actor in origin['draft']['actors']:
        ident = actor['id']
        seeds = [m['text'] for m in origin['draft']['memories'] if m['actorId'] == ident]
        characters[ident] = {
            'runtime_id': origin['runtime_ids'][ident], 'name': actor['name'],
            'role': actor['role'], 'goal': actor['goal'], 'place_id': actor['placeId'],
            'memory_seeds': [{'seed_id': f"{event['id']}:seed:{ident}:{i}", 'text': text,
                              'source': {'event_id': event['id'], 'kind': 'genesis.seed'}}
                             for i, text in enumerate(seeds)],
            'inventory': None,
        }
    return world, characters
