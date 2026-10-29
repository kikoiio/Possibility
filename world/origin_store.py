"""Persist a v1 origin and safely retry it after resource operations.

The caller must authenticate and persist the confirmation and its operation
binding, allocate the world ID, and ensure exclusive access and isolation.
The engine must supply an independently persisted identity via get_world_id();
this adapter cannot establish independence, freezing, or real user consent.
Resource retries require explicit exclusive=True and reconcile the fake engine;
this does not implement locking, Luanti persistence, or public projections.
Events and snapshots contain private data and must not be exposed as public views.
"""
from world.origin import OriginError, create_origin_event, origin_snapshot, validate_world_id
from world.origin_resources import Coordinator
from world.store import Conflict, _json, _read_json


def _check_engine(engine, world_id):
    try:
        engine_id = engine.get_world_id()
        validate_world_id(engine_id)
    except Exception as exc:
        raise OriginError('cannot read valid engine world_id') from exc
    if engine_id != world_id:
        raise OriginError('engine world_id mismatch')


def create_origin(store, engine, world_id, operation_id, confirmed_draft_ref, *, exclusive=False):
    """Commit an origin or retry the identical original request.

    A raised exception from commit can mean the commit succeeded but its response
    was lost. Retry with the same full request; do not allocate another operation.
    The caller must hold exclusive ownership and isolate projection readers.
    After resource registration it must also explicitly pass exclusive=True;
    reconciliation may write projections and may fail after partial writes.
    The caller must keep the world frozen on every failure.
    """
    validate_world_id(world_id)
    event = create_origin_event(world_id, confirmed_draft_ref)
    if operation_id != event['id'] or type(operation_id) is not str:
        raise OriginError('operation_id does not match confirmation')
    world, characters = origin_snapshot(event, world_id)
    _check_engine(engine, world_id)
    state = store.recover()
    if _json(state['clock']) != _json({'time': 0, 'paused': True}):
        raise OriginError('invalid v1 clock')
    if state['version'] == 0:
        if state['events'] or state['world'] or state['characters']:
            raise OriginError('store is not empty')
    else:
        persisted = state['events'][0]['event']
        persisted_world, persisted_characters = origin_snapshot(persisted, world_id)
        if _json(persisted) != _json(event):
            raise Conflict('origin request differs from committed operation')
        # recover() has validated the transaction log; inspect the original
        # request, not the current resource-bearing checkpoint.
        row = store.db.execute('SELECT request FROM events WHERE version=1').fetchone()
        if row is None:
            raise OriginError('missing origin request')
        request = _read_json(row[0])
        if (_json(request['world']) != _json(persisted_world) or
                _json(request['characters']) != _json(persisted_characters)):
            raise OriginError('origin snapshot does not match event')
        original = {'event': event, 'expected_version': 0, 'world': world,
                    'characters': characters, 'elapsed': 0, 'paused': None}
        if _json(request) != _json(original):
            raise Conflict('origin commit request differs from original')
        if state['version'] == 1:
            if (_json(state['world']) != _json(persisted_world) or
                    _json(state['characters']) != _json(persisted_characters)):
                raise OriginError('origin checkpoint does not match event')
            _check_engine(engine, world_id)
        else:
            coordinator = Coordinator(store, engine, world_id=world_id, exclusive=exclusive)
            result = coordinator.reconcile()
            if result != {'phase': 'READY', 'version': state['version']}:
                raise OriginError('resource reconciliation did not reach ready')
        return {'version': 1, 'event_id': operation_id}
    _check_engine(engine, world_id)
    return store.commit(event, 0, world, characters, elapsed=0, paused=None)
