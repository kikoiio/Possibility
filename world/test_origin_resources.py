import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from world.origin import create_origin_event, draft_sha256, origin_snapshot
from world.origin_resources import Coordinator, ReconcileError
from world.store import WorldStore, _json

WORLD = '12345678-1234-4234-8234-123456789abc'


class Engine:
    def __init__(self):
        self.world_id = WORLD
        self.nodes = {'1,0,0': 'ore', '2,0,0': 'ore'}
        self.inventories = {'traveler': {}, 'alice': {}}
        self.fail = None
        self.writes = []

    def get_world_id(self): return self.world_id
    def get_node(self, key): return self.nodes[key]
    def get_inventory(self, key): return copy.deepcopy(self.inventories[key])
    def set_node(self, key, value):
        self.writes.append(('node', key))
        if self.fail == 'before_node': raise RuntimeError('node')
        self.nodes[key] = value
        if self.fail == 'after_node': raise RuntimeError('node')
    def set_inventory(self, key, value):
        self.writes.append(('inventory', key))
        if self.fail == 'before_inventory': raise RuntimeError('inventory')
        self.inventories[key] = copy.deepcopy(value)
        if self.fail == 'after_inventory': raise RuntimeError('inventory')


class OriginResourcesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.path = Path(self.tmp.name) / 'world.db'
        self.store = WorldStore(self.path, create=True)
        self.engine = Engine()
        draft = json.loads((Path(__file__).parent.parent / 'genesis/example.json').read_text())
        draft['actors'].append({'id': 'alice', 'name': 'Alice', 'role': 'friend', 'goal': 'secret goal', 'placeId': 'bank'})
        draft['memories'].append({'actorId': 'alice', 'text': 'private memory'})
        event = create_origin_event(WORLD, {'draft_id': 'draft', 'draft_revision': 1,
            'draft_sha256': draft_sha256(draft), 'operation_id': 'origin', 'status': 'confirmed', 'draft': draft})
        world, chars = origin_snapshot(event, WORLD)
        self.store.commit(event, 0, world, chars)
        self.original = copy.deepcopy(chars)
        self.co = Coordinator(self.store, self.engine, world_id=WORLD, exclusive=True)

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def register(self):
        return self.co.register('register', {'1,0,0': 'ore', '2,0,0': 'ore'},
                                {'1,0,0': 'ore', '2,0,0': 'ore'}, {'traveler': {}, 'alice': {}})

    def restart(self):
        self.store.close()
        self.store = WorldStore(self.path)
        self.co = Coordinator(self.store, self.engine, world_id=WORLD, exclusive=True)

    def test_origin_register_gather_build_and_retry(self):
        self.assertEqual(self.co.reconcile(), {'phase': 'ORIGIN_ONLY', 'version': 1})
        self.assertEqual(self.register()['version'], 2)
        result = self.co.apply('g', 2, 'gather', '1,0,0', 'alice')
        self.assertEqual(self.engine.inventories['alice'], {'ore': 1})
        self.co.apply('b', 3, 'build', '1,0,0', 'alice')
        self.assertEqual(self.co.apply('g', 2, 'gather', '1,0,0', 'alice'), result)
        self.assertEqual(self.register()['version'], 2)
        state = self.store.recover()
        self.assertEqual(state['version'], 4)
        for key, before in self.original.items():
            actual = dict(state['characters'][key]); actual['inventory'] = None
            self.assertEqual(actual, before)
        for args in [('g', 3, 'gather', '1,0,0', 'alice'), ('g', 2, 'gather', '2,0,0', 'alice'), ('stale', 2, 'gather', '1,0,0', 'alice')]:
            with self.assertRaises(ReconcileError): self.co.apply(*args)
        self.assertEqual(self.store.recover()['version'], 4)

    def test_failure_windows_and_retry_after_restart(self):
        for failure in ('before_node', 'after_node', 'before_inventory', 'after_inventory'):
            with self.subTest(failure=failure):
                self.register()
                self.engine.fail = failure
                with self.assertRaises(RuntimeError): self.co.apply('g', 2, 'gather', '1,0,0', 'alice')
                self.assertFalse(self.co.ready)
                self.restart()
                self.engine.fail = None
                self.assertEqual(self.co.apply('g', 2, 'gather', '1,0,0', 'alice')['version'], 3)
                self.assertEqual(self.engine.nodes['1,0,0'], 'air')
                self.assertEqual(self.engine.inventories['alice'], {'ore': 1})
                # Return to origin-only state for the next independent failure window.
                self.store.close(); self.tmp.cleanup(); self.setUp()

    def test_unknown_preflight_and_identity(self):
        self.register()
        self.co.apply('g', 2, 'gather', '1,0,0', 'alice')
        self.engine.nodes['1,0,0'] = 'ore'
        self.engine.inventories['alice'] = {}
        self.engine.nodes['2,0,0'] = 'foreign'
        self.engine.writes.clear()
        with self.assertRaises(ReconcileError): self.co.reconcile()
        self.assertEqual(self.engine.writes, [])
        self.engine.nodes['2,0,0'] = 'ore'
        self.engine.world_id = 'other'
        with self.assertRaises(ReconcileError): self.co.reconcile()
        self.assertEqual(self.engine.writes, [])
        self.assertFalse(self.co.ready)
        with self.assertRaises(ReconcileError): Coordinator(self.store, self.engine, world_id=WORLD, exclusive=False)

    def test_registration_validation_and_preconditions(self):
        for nodes in ({'01,0,0': 'ore'}, {'-0,0,0': 'ore'}, {'1,0,0': 'air'}):
            with self.assertRaises(ReconcileError): self.co.register('bad', nodes, nodes, {'alice': {}, 'traveler': {}})
        self.engine.nodes['1,0,0'] = 'air'
        with self.assertRaises(ReconcileError): self.register()
        self.assertEqual(self.store.recover()['version'], 1)
        self.engine.nodes['1,0,0'] = 'ore'
        self.register()
        with self.assertRaises(ReconcileError): self.co.apply('bad', 2, 'build', '1,0,0', 'alice')
        self.assertEqual(self.store.recover()['version'], 2)

    def test_history_and_intermediate_snapshot_tampering(self):
        self.register()
        self.co.apply('g', 2, 'gather', '1,0,0', 'alice')
        row = self.store.db.execute('SELECT request FROM events WHERE version=2').fetchone()
        request = json.loads(row[0])
        request['characters']['alice']['goal'] = 'tampered'
        self.store.db.execute('UPDATE events SET request=? WHERE version=2', (_json(request),))
        self.engine.writes.clear()
        with self.assertRaises(ReconcileError): self.co.reconcile()
        self.assertEqual(self.engine.writes, [])

    def test_registration_response_lost_and_conflict(self):
        commit = self.store.commit
        def lost(*args, **kwargs):
            commit(*args, **kwargs)
            raise RuntimeError('lost')
        self.store.commit = lost
        with self.assertRaises(RuntimeError): self.register()
        self.store.commit = commit
        self.restart()
        self.assertEqual(self.register()['version'], 2)
        with self.assertRaises(ReconcileError):
            self.co.register('register', {'1,0,0': 'wood'}, {'1,0,0': 'wood'},
                             {'alice': {}, 'traveler': {}})
        self.assertEqual(self.store.recover()['version'], 2)

    def test_unknown_event_is_rejected(self):
        self.register()
        state = self.store.recover()
        self.store.commit({'id': 'other', 'type': 'unknown',
                           'data': {'contract_version': 1, 'world_id': WORLD}},
                          2, state['world'], state['characters'])
        with self.assertRaises(ReconcileError): self.co.reconcile()
        self.assertFalse(self.co.ready)

    def test_unpaused_clock_is_rejected(self):
        self.register()
        state = self.store.recover()
        self.store.commit({'id': 'other', 'type': 'unknown', 'data': {}}, 2,
                          state['world'], state['characters'], paused=False)
        with self.assertRaises(ReconcileError): self.co.reconcile()
        self.assertFalse(self.co.ready)

    def test_unknown_inventory_prevents_all_repair_writes(self):
        self.register()
        self.co.apply('g', 2, 'gather', '1,0,0', 'alice')
        self.engine.nodes['1,0,0'] = 'ore'
        self.engine.inventories['traveler'] = {'ore': 7}
        self.engine.writes.clear()
        with self.assertRaises(ReconcileError): self.co.reconcile()
        self.assertEqual(self.engine.writes, [])

    def test_engine_callback_cannot_reenter_public_operations(self):
        self.register()
        original = self.engine.get_node
        attempts = []
        def callback(key):
            if not attempts:
                attempts.append('started')
                for operation in (
                    self.co.reconcile,
                    lambda: self.co.apply('nested', 2, 'gather', '2,0,0', 'alice'),
                    lambda: self.register(),
                ):
                    with self.assertRaises(ReconcileError):
                        operation()
            return original(key)
        self.engine.get_node = callback
        self.assertEqual(self.co.apply('outer', 2, 'gather', '1,0,0', 'alice')['version'], 3)
        self.assertEqual(attempts, ['started'])
        self.assertTrue(self.co.ready)
        self.assertEqual(self.store.recover()['version'], 3)
        self.assertEqual(self.engine.nodes, {'1,0,0': 'air', '2,0,0': 'ore'})

    def test_database_version_change_during_final_read_keeps_frozen(self):
        self.register()
        original = self.engine.get_inventory
        calls = 0
        def callback(key):
            nonlocal calls
            calls += 1
            if calls == 4:
                state = self.store.recover()
                self.store.commit({'id': 'external', 'type': 'unknown', 'data': {}},
                                  state['version'], state['world'], state['characters'])
            return original(key)
        self.engine.get_inventory = callback
        with self.assertRaisesRegex(ReconcileError, 'version changed'):
            self.co.reconcile()
        self.assertFalse(self.co.ready)
        self.assertEqual(self.store.recover()['version'], 3)

    def test_noncanonical_clock_request_is_rejected(self):
        self.register()
        row = self.store.db.execute('SELECT request FROM events WHERE version=2').fetchone()
        request = json.loads(row[0])
        request['paused'] = True
        self.store.db.execute('UPDATE events SET request=? WHERE version=2', (_json(request),))
        self.engine.writes.clear()
        with self.assertRaises(ReconcileError): self.co.reconcile()
        self.assertFalse(self.co.ready)
        self.assertEqual(self.engine.writes, [])

    def test_float_zero_elapsed_is_not_a_canonical_request(self):
        from world.origin_resources import _read_json
        self.register()
        def noncanonical(raw):
            request = _read_json(raw)
            if request['event']['type'] == 'resource.registered':
                request['elapsed'] = 0.0
            return request
        with patch('world.origin_resources._read_json', side_effect=noncanonical):
            with self.assertRaises(ReconcileError): self.co.reconcile()
        self.assertFalse(self.co.ready)

    def test_commit_response_lost(self):
        self.register()
        commit = self.store.commit
        def lost(*args, **kwargs):
            commit(*args, **kwargs)
            raise RuntimeError('lost')
        self.store.commit = lost
        with self.assertRaises(RuntimeError): self.co.apply('g', 2, 'gather', '1,0,0', 'alice')
        self.store.commit = commit
        self.restart()
        self.assertEqual(self.co.apply('g', 2, 'gather', '1,0,0', 'alice')['version'], 3)
        self.assertEqual(self.store.recover()['version'], 3)


if __name__ == '__main__': unittest.main()
