"""Exclusive, bounded resource projection over WorldStore; no Luanti adapter."""
from copy import deepcopy


class ReconcileError(Exception):
    """Projection is unavailable or cannot be reconciled safely."""


def _text(value):
    return type(value) is str and bool(value)


def _inventory(value, resources):
    if type(value) is not dict or any(not _text(k) or k not in resources or
            type(v) is not int or v <= 0 or v > 2147483647 for k, v in value.items()):
        raise ReconcileError('invalid inventory')
    return deepcopy(value)


def _registration(nodes, characters):
    if (type(nodes) is not dict or not nodes or
            any(not _text(k) or not _text(v) or v == 'air' for k, v in nodes.items())):
        raise ReconcileError('invalid node registration')
    if (type(characters) is not list or not characters or
            any(not _text(x) for x in characters) or len(set(characters)) != len(characters)):
        raise ReconcileError('invalid character registration')
    return dict(nodes), sorted(characters)


class Coordinator:
    """Caller must enforce one exclusive writer and isolate all projection readers."""
    def __init__(self, store, engine, nodes, characters, *, world_id):
        if not _text(world_id):
            raise ReconcileError('world id must be a nonempty string')
        self.world_id = world_id
        self.store, self.engine = store, engine
        self.nodes, self.characters = _registration(nodes, characters)
        self.resources = set(self.nodes.values())
        self.ready = False

    def _check_world(self):
        if self.engine.get_world_id() != self.world_id:
            raise ReconcileError('engine world id mismatch')

    def _read(self):
        self._check_world()
        nodes = {key: self.engine.get_node(key) for key in self.nodes}
        inventories = {key: _inventory(self.engine.get_inventory(key), self.resources)
                       for key in self.characters}
        return nodes, inventories

    def initialize(self, operation_id, expected_nodes, expected_inventories):
        """Explicitly register a fresh store, using caller-supplied initial values."""
        self.ready = False
        if not _text(operation_id):
            raise ReconcileError('operation id required')
        state = self.store.recover()
        if state['version'] != 0 or state['world'] or state['characters']:
            raise ReconcileError('initialization requires an empty store')
        if type(expected_nodes) is not dict or set(expected_nodes) != set(self.nodes):
            raise ReconcileError('initial nodes do not match registration')
        if any(type(v) is not str or v not in ('air', self.nodes[k]) for k, v in expected_nodes.items()):
            raise ReconcileError('invalid initial node')
        if type(expected_inventories) is not dict or set(expected_inventories) != set(self.characters):
            raise ReconcileError('initial inventories do not match registration')
        inventories = {k: _inventory(v, self.resources) for k, v in expected_inventories.items()}
        actual_nodes, actual_inventories = self._read()
        if actual_nodes != expected_nodes or actual_inventories != inventories:
            raise ReconcileError('initial projection mismatch')
        world = {'schema': 2, 'world_id': self.world_id, 'registration': deepcopy(self.nodes), 'nodes': deepcopy(expected_nodes)}
        characters = {k: {'inventory': v} for k, v in inventories.items()}
        event = {'id': operation_id, 'type': 'resource.init',
                 'data': {'world': deepcopy(world), 'characters': deepcopy(characters)}}
        self._check_world()
        result = self.store.commit(event, 0, world, characters)
        self.reconcile()
        return result

    def _history(self):
        state = self.store.recover()
        events = state['events']
        if not events or events[0]['event']['type'] != 'resource.init':
            raise ReconcileError('missing resource initialization')
        initial = events[0]['event']['data']
        if type(initial) is not dict or set(initial) != {'world', 'characters'}:
            raise ReconcileError('invalid initialization')
        world, chars = deepcopy(initial['world']), deepcopy(initial['characters'])
        if (type(world) is not dict or set(world) != {'schema', 'world_id', 'registration', 'nodes'} or
                type(world['schema']) is not int or world['schema'] != 2 or
                world['world_id'] != self.world_id or
                world['registration'] != self.nodes or type(world['nodes']) is not dict or
                set(world['nodes']) != set(self.nodes) or type(chars) is not dict or
                set(chars) != set(self.characters)):
            raise ReconcileError('registration mismatch')
        if any(type(v) is not str or v not in ('air', self.nodes[k]) for k, v in world['nodes'].items()):
            raise ReconcileError('invalid initial node')
        for actor in self.characters:
            if type(chars[actor]) is not dict or set(chars[actor]) != {'inventory'}:
                raise ReconcileError('invalid character')
            _inventory(chars[actor]['inventory'], self.resources)
        node_history = {k: {v} for k, v in world['nodes'].items()}
        inv_history = {k: [deepcopy(chars[k]['inventory'])] for k in self.characters}
        operations = {}
        for entry in events[1:]:
            event = entry['event']
            if event['type'] != 'resource.change':
                raise ReconcileError('unexpected event')
            data = event['data']
            if type(data) is not dict or set(data) != {'kind', 'node', 'character'}:
                raise ReconcileError('invalid event')
            self._change(world, chars, data['kind'], data['node'], data['character'])
            node_history[data['node']].add(world['nodes'][data['node']])
            inv_history[data['character']].append(deepcopy(chars[data['character']]['inventory']))
            operations[event['id']] = (deepcopy(data), entry['version'])
        if world != state['world'] or chars != state['characters']:
            raise ReconcileError('resource history and checkpoint disagree')
        return state, node_history, inv_history, operations

    def _change(self, world, chars, kind, node, character):
        if (type(kind) is not str or kind not in ('gather', 'build') or
                not _text(node) or node not in self.nodes or
                not _text(character) or character not in self.characters):
            raise ReconcileError('unregistered or invalid operation')
        resource = self.nodes[node]
        inv = chars[character]['inventory']
        count = inv.get(resource, 0)
        if kind == 'gather':
            if world['nodes'][node] != resource or count >= 2147483647:
                raise ReconcileError('gather precondition failed')
            world['nodes'][node], inv[resource] = 'air', count + 1
        else:
            if world['nodes'][node] != 'air' or count == 0:
                raise ReconcileError('build precondition failed')
            world['nodes'][node] = resource
            if count == 1:
                del inv[resource]
            else:
                inv[resource] = count - 1

    def reconcile(self):
        """Preflight all projection values, then write and verify known old values."""
        self.ready = False
        state, node_history, inv_history, _ = self._history()
        actual_nodes, actual_inv = self._read()
        for key, value in actual_nodes.items():
            if type(value) is not str or value not in node_history[key]:
                raise ReconcileError('unknown node value: ' + key)
        for key, value in actual_inv.items():
            if value not in inv_history[key]:
                raise ReconcileError('unknown inventory value: ' + key)
        for key, desired in state['world']['nodes'].items():
            if actual_nodes[key] != desired:
                self._check_world()
                if self.engine.set_node(key, desired) is False or self.engine.get_node(key) != desired:
                    raise ReconcileError('node projection failed: ' + key)
        for key in self.characters:
            desired = state['characters'][key]['inventory']
            if actual_inv[key] != desired:
                self._check_world()
                if self.engine.set_inventory(key, deepcopy(desired)) is False or self.engine.get_inventory(key) != desired:
                    raise ReconcileError('inventory projection failed: ' + key)
        # Verify all values again, including those which were already current.
        nodes, inventories = self._read()
        if nodes != state['world']['nodes'] or inventories != {k: state['characters'][k]['inventory'] for k in self.characters}:
            raise ReconcileError('projection changed during reconciliation')
        self.ready = True
        return state['version']

    def apply(self, operation_id, kind, node, character):
        if not self.ready:
            raise ReconcileError('reconciliation required')
        self.ready = False
        if not _text(operation_id) or not _text(node) or not _text(character) or type(kind) is not str:
            raise ReconcileError('invalid operation')
        state, _, _, operations = self._history()
        data = {'kind': kind, 'node': node, 'character': character}
        if operation_id in operations:
            old, version = operations[operation_id]
            if old != data:
                raise ReconcileError('operation id conflict')
            self.reconcile()
            return {'version': version, 'event_id': operation_id}
        if any(e['event']['id'] == operation_id for e in state['events']):
            raise ReconcileError('operation id conflict')
        actual_nodes, actual_inv = self._read()
        if actual_nodes != state['world']['nodes'] or actual_inv != {k: state['characters'][k]['inventory'] for k in self.characters}:
            raise ReconcileError('projection differs from checkpoint')
        world, characters = deepcopy(state['world']), deepcopy(state['characters'])
        self._change(world, characters, kind, node, character)
        event = {'id': operation_id, 'type': 'resource.change', 'data': data}
        self._check_world()
        result = self.store.commit(event, state['version'], world, characters)
        self.reconcile()
        return result
