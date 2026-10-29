"""v1 origin-backed resource projection for a single exclusive fake engine.

Coordinator(store, engine, world_id=..., exclusive=True) requires the caller to
hold exclusive ownership and isolate readers until READY. The engine implements
get_world_id/get_node/get_inventory and set_node/set_inventory. Its identity
must be stored independently of the database. Construct only after a valid
origin commit. reconcile() returns {'phase', 'version'}; register(id, nodes,
initial_nodes, initial_inventories) and apply(id, expected_version, kind, node,
character) return the original {'version', 'event_id'} after projection succeeds.
Retries must retain the entire original request, including expected_version.
Failures leave phase FROZEN; call reconcile before new operations. An exception
may follow a successful database commit, so retry with the same operation ID.
This module exposes no public/authorized character view and does not provide
locking, persistence of the engine, or a Luanti adapter.
"""
from copy import deepcopy
from functools import wraps
import re
from threading import Lock

from world.origin import OriginError, origin_snapshot, validate_world_id
from world.reconcile import ReconcileError, _inventory
from world.store import _json, _read_json

_COORD = re.compile(r'(?:0|-[1-9][0-9]*|[1-9][0-9]*),(?:0|-[1-9][0-9]*|[1-9][0-9]*),(?:0|-[1-9][0-9]*|[1-9][0-9]*)\Z')
_MAX = 2147483647


def _text(value):
    if type(value) is not str or not value.strip():
        raise ReconcileError('invalid text')
    try:
        value.encode('utf-8')
    except UnicodeError:
        raise ReconcileError('invalid text') from None


def _same(a, b):
    return _json(a) == _json(b)


def _registration(nodes, initial_nodes, inventories, characters):
    if type(nodes) is not dict or not nodes:
        raise ReconcileError('invalid registration')
    for key, value in nodes.items():
        if type(key) is not str or not _COORD.fullmatch(key):
            raise ReconcileError('invalid node coordinate')
        _text(value)
        if value == 'air':
            raise ReconcileError('invalid resource')
    if type(initial_nodes) is not dict or set(initial_nodes) != set(nodes):
        raise ReconcileError('invalid initial nodes')
    if any(type(v) is not str or v not in ('air', nodes[k]) for k, v in initial_nodes.items()):
        raise ReconcileError('invalid initial node value')
    if type(inventories) is not dict or set(inventories) != set(characters):
        raise ReconcileError('invalid initial inventories')
    for value in inventories.values():
        _inventory(value, set(nodes.values()))


def _change(world, chars, kind, node, character):
    registration = world['resources']['registration']
    if (type(kind) is not str or kind not in ('gather', 'build') or
            type(node) is not str or node not in registration or
            type(character) is not str or character not in chars):
        raise ReconcileError('invalid resource operation')
    resource = registration[node]
    inv = chars[character]['inventory']
    count = inv.get(resource, 0)
    if kind == 'gather':
        if world['resources']['nodes'][node] != resource or count >= _MAX:
            raise ReconcileError('gather precondition failed')
        world['resources']['nodes'][node] = 'air'
        inv[resource] = count + 1
    else:
        if world['resources']['nodes'][node] != 'air' or count == 0:
            raise ReconcileError('build precondition failed')
        world['resources']['nodes'][node] = resource
        if count == 1:
            del inv[resource]
        else:
            inv[resource] = count - 1


def _guarded(method):
    @wraps(method)
    def guarded(self, *args, **kwargs):
        if not self._operation_gate.acquire(blocking=False):
            raise ReconcileError('coordinator operation already in progress')
        try:
            return method(self, *args, **kwargs)
        finally:
            self._operation_gate.release()
    return guarded


class Coordinator:
    def __init__(self, store, engine, *, world_id, exclusive):
        try:
            validate_world_id(world_id)
        except OriginError as exc:
            raise ReconcileError('invalid world id') from exc
        if exclusive is not True:
            raise ReconcileError('exclusive ownership and reader isolation required')
        self.store, self.engine, self.world_id = store, engine, world_id
        self.phase = 'FROZEN'
        self._operation_gate = Lock()

    @property
    def ready(self):
        return self.phase == 'READY'

    def _identity(self):
        if self.engine.get_world_id() != self.world_id:
            raise ReconcileError('engine world id mismatch')

    def _history(self):
        self._identity()
        state = self.store.recover()
        if state['version'] < 1 or not _same(state['clock'], {'time': 0, 'paused': True}):
            raise ReconcileError('missing origin or invalid clock')
        events = state['events']
        try:
            world, chars = origin_snapshot(events[0]['event'], self.world_id)
        except (OriginError, ValueError, TypeError, KeyError) as exc:
            raise ReconcileError('invalid origin') from exc
        # Recover exposes events but not historical snapshots/clock arguments.
        # Validate each stored transaction against the derived state as well.
        requests = [_read_json(row[0]) for row in self.store.db.execute(
            'SELECT request FROM events ORDER BY version')]
        node_history, inv_history = {}, {}
        operations = {}
        for i, (entry, request) in enumerate(zip(events, requests)):
            event = entry['event']
            _text(event['id'])
            if event['id'] in operations:
                raise ReconcileError('duplicate operation id')
            if i:
                data = event['data']
                if type(data) is not dict or type(data.get('contract_version')) is not int or data.get('contract_version') != 1 or data.get('world_id') != self.world_id:
                    raise ReconcileError('invalid event metadata')
                if i == 1 and event['type'] == 'resource.registered':
                    if set(data) != {'contract_version', 'world_id', 'origin_event_id', 'nodes', 'initial_nodes', 'initial_inventories'} or data['origin_event_id'] != events[0]['event']['id']:
                        raise ReconcileError('invalid registration event')
                    _registration(data['nodes'], data['initial_nodes'], data['initial_inventories'], chars)
                    world['resources'] = {'registration': deepcopy(data['nodes']), 'nodes': deepcopy(data['initial_nodes'])}
                    for key in chars:
                        chars[key]['inventory'] = deepcopy(data['initial_inventories'][key])
                    node_history = {k: [v] for k, v in data['initial_nodes'].items()}
                    inv_history = {k: [deepcopy(v)] for k, v in data['initial_inventories'].items()}
                elif i >= 2 and event['type'] == 'resource.change':
                    if set(data) != {'contract_version', 'world_id', 'kind', 'node', 'character'}:
                        raise ReconcileError('invalid change event')
                    _change(world, chars, data['kind'], data['node'], data['character'])
                    node_history[data['node']].append(world['resources']['nodes'][data['node']])
                    inv_history[data['character']].append(deepcopy(chars[data['character']]['inventory']))
                else:
                    raise ReconcileError('unexpected event')
            if (type(request['elapsed']) is not int or request['elapsed'] != 0 or request['paused'] is not None or
                    not _same(request['world'], world) or not _same(request['characters'], chars)):
                raise ReconcileError('history and transaction snapshot disagree')
            operations[event['id']] = (deepcopy(event), entry['version'])
        if len(requests) != len(events) or not _same(state['world'], world) or not _same(state['characters'], chars):
            raise ReconcileError('history and checkpoint disagree')
        return state, node_history, inv_history, operations

    def _read(self, state):
        self._identity()
        registration = state['world']['resources']['registration']
        nodes = {k: self.engine.get_node(k) for k in registration}
        inv = {k: _inventory(self.engine.get_inventory(k), set(registration.values())) for k in state['characters']}
        self._identity()
        return nodes, inv

    @_guarded
    def reconcile(self):
        return self._reconcile()

    def _check_version(self, version):
        if self.store.recover()['version'] != version:
            raise ReconcileError('database version changed during projection')

    def _reconcile(self):
        self.phase = 'FROZEN'
        state, nodes_history, inv_history, _ = self._history()
        if state['world']['resources'] is None:
            self._identity()
            self._check_version(state['version'])
            self.phase = 'ORIGIN_ONLY'
            return {'phase': self.phase, 'version': state['version']}
        nodes, inv = self._read(state)
        for key, value in nodes.items():
            if type(value) is not str or value not in nodes_history[key]:
                raise ReconcileError('unknown node value')
        for key, value in inv.items():
            if not any(_same(value, old) for old in inv_history[key]):
                raise ReconcileError('unknown inventory value')
        for key, desired in state['world']['resources']['nodes'].items():
            if nodes[key] != desired:
                self._identity()
                if self.engine.set_node(key, desired) is False or self.engine.get_node(key) != desired:
                    raise ReconcileError('node projection failed')
        for key, character in state['characters'].items():
            desired = character['inventory']
            if not _same(inv[key], desired):
                self._identity()
                if self.engine.set_inventory(key, deepcopy(desired)) is False or not _same(self.engine.get_inventory(key), desired):
                    raise ReconcileError('inventory projection failed')
        nodes, inv = self._read(state)
        if not _same(nodes, state['world']['resources']['nodes']) or not _same(inv, {k: v['inventory'] for k, v in state['characters'].items()}):
            raise ReconcileError('projection changed')
        self._check_version(state['version'])
        self.phase = 'READY'
        return {'phase': self.phase, 'version': state['version']}

    @_guarded
    def register(self, operation_id, nodes, initial_nodes, initial_inventories):
        self.phase = 'FROZEN'
        _text(operation_id)
        state, _, _, operations = self._history()
        data = {'contract_version': 1, 'world_id': self.world_id, 'origin_event_id': state['events'][0]['event']['id'], 'nodes': deepcopy(nodes), 'initial_nodes': deepcopy(initial_nodes), 'initial_inventories': deepcopy(initial_inventories)}
        event = {'id': operation_id, 'type': 'resource.registered', 'data': data}
        if operation_id in operations:
            old, version = operations[operation_id]
            if not _same(event, old) or version != 2:
                raise ReconcileError('operation id conflict')
            self._reconcile()
            return {'version': version, 'event_id': operation_id}
        if state['version'] != 1:
            raise ReconcileError('registration requires origin only')
        _registration(nodes, initial_nodes, initial_inventories, state['characters'])
        world, chars = deepcopy(state['world']), deepcopy(state['characters'])
        world['resources'] = {'registration': deepcopy(nodes), 'nodes': deepcopy(initial_nodes)}
        for key in chars:
            chars[key]['inventory'] = deepcopy(initial_inventories[key])
        actual = self._read({'world': world, 'characters': chars})
        if not _same(actual[0], initial_nodes) or not _same(actual[1], initial_inventories):
            raise ReconcileError('initial projection mismatch')
        self._identity()
        result = self.store.commit(event, 1, world, chars)
        self._reconcile()
        return result

    @_guarded
    def apply(self, operation_id, expected_version, kind, node, character):
        was_ready = self.ready
        self.phase = 'FROZEN'
        _text(operation_id)
        if type(expected_version) is not int or expected_version < 0:
            raise ReconcileError('invalid expected version')
        state, _, _, operations = self._history()
        event = {'id': operation_id, 'type': 'resource.change', 'data': {'contract_version': 1, 'world_id': self.world_id, 'kind': kind, 'node': node, 'character': character}}
        if operation_id in operations:
            old, version = operations[operation_id]
            if version - 1 != expected_version or not _same(event, old):
                raise ReconcileError('operation id conflict')
            self._reconcile()
            return {'version': version, 'event_id': operation_id}
        if not was_ready or state['world']['resources'] is None:
            raise ReconcileError('reconciliation required')
        if expected_version != state['version']:
            raise ReconcileError('stale version')
        nodes, inv = self._read(state)
        if not _same(nodes, state['world']['resources']['nodes']) or not _same(inv, {k: v['inventory'] for k, v in state['characters'].items()}):
            raise ReconcileError('projection differs from checkpoint')
        world, chars = deepcopy(state['world']), deepcopy(state['characters'])
        _change(world, chars, kind, node, character)
        self._identity()
        result = self.store.commit(event, expected_version, world, chars)
        self._reconcile()
        return result
