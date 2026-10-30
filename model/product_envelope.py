"""Validation for the product-facing ``wispiva.model-input`` envelope.

The Luanti producer is Lua, so this module deliberately validates the JSON
boundary again immediately before a provider call.  It never grants access;
the producer must already have filtered records for the actor.  The validator
only proves that the envelope is self-consistent, bounded, and safe to send.
"""
from __future__ import annotations

import json
import math
from typing import Any, Mapping


MAX_RECORDS = 32
MAX_TEXT_BYTES = 4096
MAX_ENVELOPE_BYTES = 16000
SCOPES = frozenset({'public', 'private', 'direct', 'system'})
STATUSES = frozenset({'succeeded', 'failed', 'rejected', 'stale', 'unknown'})
EPISTEMIC = {'facts': 'fact', 'experiences': 'experience',
             'rumors': 'rumor', 'unknowns': 'unknown'}


class EnvelopeError(ValueError):
    """The provider boundary received an invalid product envelope."""


def _fields(value: Any, required: set[str], optional: set[str] = set()) -> None:
    if type(value) is not dict or not required <= value.keys() or not value.keys() <= required | optional:
        raise EnvelopeError('invalid_model_input')


def _text(value: Any, *, empty: bool = False) -> str:
    if not isinstance(value, str) or (not empty and not value) or len(value.encode('utf-8')) > MAX_TEXT_BYTES:
        raise EnvelopeError('invalid_model_input')
    return value


def _integer(value: Any, *, minimum: int = 0) -> int:
    # Luanti's JSON writer serializes every Lua number as a JSON number;
    # integral values therefore arrive as Python floats at this boundary.
    # Accept only finite integral floats, while continuing to reject booleans
    # and fractional values.
    if type(value) not in (int, float) or not math.isfinite(value) or int(value) != value or value < minimum:
        raise EnvelopeError('invalid_model_input')
    return int(value)


def _number(value: Any) -> Any:
    if type(value) not in (int, float) or not math.isfinite(value):
        raise EnvelopeError('invalid_model_input')
    return value


def _array(value: Any, maximum: int) -> list[Any]:
    if type(value) is not list or len(value) > maximum:
        raise EnvelopeError('invalid_model_input')
    return value


def _unique_strings(value: Any, *, actor: str | None = None) -> None:
    values = _array(value, 64)
    if not values or any(not isinstance(item, str) or not item for item in values):
        raise EnvelopeError('invalid_model_input')
    if len(set(values)) != len(values) or actor is not None and actor not in values:
        raise EnvelopeError('invalid_model_input')


def _source(value: Any) -> None:
    _fields(value, {'kind', 'id'}, {'revision'})
    _text(value['kind'])
    _text(value['id'])
    if 'revision' in value:
        _integer(value['revision'])


def _knowledge_record(value: Any, actor_id: str, expected: str) -> None:
    _fields(value, {'id', 'text', 'source', 'epistemic'}, {'access', 'captured_at'})
    _text(value['id'])
    _text(value['text'])
    if value['epistemic'] != expected:
        raise EnvelopeError('invalid_model_input')
    _source(value['source'])
    access = value.get('access')
    if access is None:
        raise EnvelopeError('invalid_model_input')
    _fields(access, {'scope', 'audience'})
    if access['scope'] not in SCOPES:
        raise EnvelopeError('invalid_model_input')
    _unique_strings(access['audience'], actor=actor_id)
    if value.get('captured_at') is not None:
        _number(value['captured_at'])


def validate(value: Mapping[str, Any], *, max_bytes: int = MAX_ENVELOPE_BYTES) -> bool:
    """Validate one product envelope without mutating it."""
    if type(value) is not dict:
        raise EnvelopeError('invalid_model_input')
    _fields(value, {'schema', 'version', 'request', 'actor', 'knowledge', 'current', 'feedback'})
    if value['schema'] != 'wispiva.model-input' or value['version'] != 1:
        raise EnvelopeError('invalid_model_input')

    request = value['request']
    _fields(request, {'decision_id', 'world_id', 'actor_id', 'origin_event_id',
                      'world_revision', 'observed_at'})
    for key in ('decision_id', 'world_id', 'actor_id', 'origin_event_id'):
        _text(request[key])
    _integer(request['world_revision'])
    _number(request['observed_at'])
    actor_id = request['actor_id']

    actor = value['actor']
    _fields(actor, {'id', 'runtime_id', 'name', 'role', 'goal', 'permissions'})
    if actor['id'] != actor_id:
        raise EnvelopeError('invalid_model_input')
    _text(actor['id']); _text(actor['name'])
    _integer(actor['runtime_id'])
    for key in ('role', 'goal'):
        _fields(actor[key], {'text', 'source'})
        _text(actor[key]['text'])
        _source(actor[key]['source'])
    permissions = actor['permissions']
    _fields(permissions, {'read_scopes', 'allowed_actions'})
    _unique_strings(permissions['read_scopes'])
    _unique_strings(permissions['allowed_actions'])

    knowledge = value['knowledge']
    _fields(knowledge, set(EPISTEMIC))
    seen: set[str] = set()
    for section, expected in EPISTEMIC.items():
        for record in _array(knowledge[section], MAX_RECORDS):
            _knowledge_record(record, actor_id, expected)
            if record['id'] in seen:
                raise EnvelopeError('invalid_model_input')
            seen.add(record['id'])

    current = value['current']
    _fields(current, {'observation', 'inventory', 'affordances'})
    for key in ('observation', 'inventory', 'affordances'):
        if type(current[key]) is not dict:
            raise EnvelopeError('invalid_model_input')

    feedback = value['feedback']
    if type(feedback) is not dict or type(feedback.get('available')) is not bool:
        raise EnvelopeError('invalid_model_input')
    if feedback['available']:
        _fields(feedback, {'available', 'attempt_id', 'requested', 'status', 'reason',
                           'event_id', 'observed_at', 'world_revision'})
        _text(feedback['attempt_id'])
        if type(feedback['requested']) is not dict:
            raise EnvelopeError('invalid_model_input')
        _text(feedback['requested'].get('kind'))
        if feedback['status'] not in STATUSES:
            raise EnvelopeError('invalid_model_input')
        _text(feedback['reason']); _text(feedback['event_id'])
        _number(feedback['observed_at']); _integer(feedback['world_revision'])
    else:
        _fields(feedback, {'available'})

    try:
        encoded = json.dumps(value, ensure_ascii=True, sort_keys=True,
                             separators=(',', ':'), allow_nan=False).encode('ascii')
    except (TypeError, ValueError, UnicodeError):
        raise EnvelopeError('invalid_model_input') from None
    if len(encoded) > max_bytes:
        raise EnvelopeError('invalid_model_input')
    return True
