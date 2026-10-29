from pathlib import Path
import sqlite3
import tempfile
import unittest

from store import WorldStore
from reconcile import Coordinator, ReconcileError


class Engine:
    def __init__(self):
        self.world_id = 'world-a'
        self.nodes = {'1,0,0': 'ore', '2,0,0': 'ore'}
        self.inventories = {'a': {}, 'b': {}}
        self.fail = None
        self.writes = []

    def get_world_id(self):
        return self.world_id

    def get_node(self, key):
        return self.nodes[key]

    def get_inventory(self, key):
        return dict(self.inventories[key])

    def set_node(self, key, value):
        self.writes.append(('node', key, value))
        if self.fail == 'before_node':
            raise RuntimeError('before node')
        self.nodes[key] = value
        if self.fail == 'after_node':
            raise RuntimeError('after node')

    def set_inventory(self, key, value):
        self.writes.append(('inventory', key, value))
        if self.fail == 'before_inventory':
            raise RuntimeError('before inventory')
        self.inventories[key] = dict(value)
        if self.fail == 'after_inventory':
            raise RuntimeError('after inventory')


class ReconcileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.path = Path(self.tmp.name) / 'test.db'
        self.store = WorldStore(self.path, create=True)
        self.engine = Engine()
        self.nodes = {'1,0,0': 'ore', '2,0,0': 'ore'}
        self.actors = ['a', 'b']
        self.co = Coordinator(self.store, self.engine, self.nodes, self.actors, world_id='world-a')
        self.co.initialize('init', self.engine.nodes.copy(), {'a': {}, 'b': {}})

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def restart(self):
        self.store.close()
        self.store = WorldStore(self.path)
        self.co = Coordinator(self.store, self.engine, self.nodes, self.actors, world_id='world-a')

    def test_gather_build_and_idempotent_retry(self):
        result = self.co.apply('g1', 'gather', '1,0,0', 'a')
        self.assertEqual(self.engine.nodes['1,0,0'], 'air')
        self.assertEqual(self.engine.inventories['a'], {'ore': 1})
        self.assertEqual(self.co.apply('g1', 'gather', '1,0,0', 'a'), result)
        self.co.apply('b1', 'build', '1,0,0', 'a')
        self.assertEqual(self.engine.inventories['a'], {})
        self.assertEqual(self.co.apply('g1', 'gather', '1,0,0', 'a'), result)
        with self.assertRaises(ReconcileError):
            self.co.apply('g1', 'gather', '2,0,0', 'a')
        self.assertEqual(self.store.recover()['version'], 3)

    def test_failure_windows_and_restart(self):
        for failure in ('before_node', 'after_node', 'before_inventory', 'after_inventory'):
            with self.subTest(failure=failure):
                # Return to initial state with a different fresh database per case.
                with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as root:
                    store = WorldStore(Path(root) / 'db', create=True)
                    engine = Engine()
                    co = Coordinator(store, engine, self.nodes, self.actors, world_id='world-a')
                    co.initialize('init', engine.nodes.copy(), {'a': {}, 'b': {}})
                    engine.fail = failure
                    with self.assertRaises(RuntimeError):
                        co.apply('op', 'gather', '1,0,0', 'a')
                    self.assertFalse(co.ready)
                    store.close()
                    store = WorldStore(Path(root) / 'db')
                    engine.fail = None
                    co = Coordinator(store, engine, self.nodes, self.actors, world_id='world-a')
                    self.assertEqual(co.reconcile(), 2)
                    self.assertEqual(co.apply('op', 'gather', '1,0,0', 'a')['version'], 2)
                    self.assertEqual((engine.nodes['1,0,0'], engine.inventories['a']), ('air', {'ore': 1}))
                    self.assertEqual(store.recover()['version'], 2)
                    store.close()

    def test_unknown_values_prevent_all_writes(self):
        self.engine.fail = 'before_node'
        with self.assertRaises(RuntimeError):
            self.co.apply('op', 'gather', '1,0,0', 'a')
        self.engine.fail = None
        self.engine.nodes['2,0,0'] = 'foreign'
        self.engine.writes.clear()
        with self.assertRaises(ReconcileError):
            self.co.reconcile()
        self.assertEqual(self.engine.writes, [])
        self.engine.nodes['2,0,0'] = 'ore'
        self.engine.inventories['b'] = {'ore': 9}
        with self.assertRaises(ReconcileError):
            self.co.reconcile()
        self.assertEqual(self.engine.writes, [])
        self.assertFalse(self.co.ready)

    def test_preflight_blocks_external_mutation_and_invalid_operations(self):
        self.engine.nodes['1,0,0'] = 'foreign'
        with self.assertRaises(ReconcileError):
            self.co.apply('op', 'gather', '1,0,0', 'a')
        self.assertEqual(self.store.recover()['version'], 1)
        self.assertFalse(self.co.ready)
        self.engine.nodes['1,0,0'] = 'ore'
        self.co.reconcile()
        with self.assertRaises(ReconcileError):
            self.co.apply('op', 'gather', 'unregistered', 'a')
        self.assertEqual(self.store.recover()['version'], 1)

    def test_known_older_projection_is_replayed(self):
        self.co.apply('one', 'gather', '1,0,0', 'a')
        self.co.apply('two', 'gather', '2,0,0', 'a')
        self.engine.nodes = {'1,0,0': 'ore', '2,0,0': 'ore'}
        self.engine.inventories['a'] = {}
        self.restart()
        self.co.reconcile()
        self.assertEqual(self.engine.nodes, {'1,0,0': 'air', '2,0,0': 'air'})
        self.assertEqual(self.engine.inventories['a'], {'ore': 2})

    def test_commit_failure_and_retry(self):
        self.store.db.execute("CREATE TRIGGER reject_resource BEFORE UPDATE ON checkpoint BEGIN SELECT RAISE(ABORT, 'injected'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.co.apply('op', 'gather', '1,0,0', 'a')
        self.assertFalse(self.co.ready)
        self.assertEqual(self.store.recover()['version'], 1)
        self.assertEqual(self.engine.nodes['1,0,0'], 'ore')
        self.store.db.execute('DROP TRIGGER reject_resource')
        self.co.reconcile()
        self.assertEqual(self.co.apply('op', 'gather', '1,0,0', 'a')['version'], 2)

    def test_readback_failure_keeps_gate_closed(self):
        original = self.engine.get_node
        def wrong_after_write(key):
            value = original(key)
            if key == '1,0,0' and value == 'air':
                return None
            return value
        self.engine.get_node = wrong_after_write
        with self.assertRaises(ReconcileError):
            self.co.apply('op', 'gather', '1,0,0', 'a')
        self.assertFalse(self.co.ready)
        self.engine.get_node = original
        self.co.reconcile()
        self.assertEqual(self.engine.inventories['a'], {'ore': 1})

    def test_commit_response_lost(self):
        original = self.store.commit
        def uncertain(*args, **kwargs):
            original(*args, **kwargs)
            raise RuntimeError('response lost')
        self.store.commit = uncertain
        with self.assertRaises(RuntimeError):
            self.co.apply('op', 'gather', '1,0,0', 'a')
        self.store.commit = original
        self.restart()
        self.co.reconcile()
        self.assertEqual(self.co.apply('op', 'gather', '1,0,0', 'a')['version'], 2)
        self.assertEqual(self.store.recover()['version'], 2)

    def test_incompatible_registration_and_corrupt_business_history(self):
        other = Coordinator(self.store, self.engine, {'1,0,0': 'other'}, ['a'], world_id='world-a')
        with self.assertRaises(ReconcileError):
            other.reconcile()
        state = self.store.recover()
        self.store.commit({'id': 'external', 'type': 'unrelated', 'data': {}}, state['version'], state['world'], state['characters'])
        with self.assertRaises(ReconcileError):
            self.co.reconcile()

    def test_world_binding_and_mismatch_before_projection(self):
        state = self.store.recover()
        self.assertEqual(state['world']['world_id'], 'world-a')
        self.assertEqual(state['events'][0]['event']['data']['world']['world_id'], 'world-a')
        self.co.apply('one', 'gather', '1,0,0', 'a')
        self.engine.nodes['1,0,0'] = 'ore'
        self.engine.inventories['a'] = {}
        self.engine.writes.clear()
        self.engine.world_id = 'world-b'
        self.restart()
        with self.assertRaises(ReconcileError):
            self.co.reconcile()
        self.assertEqual(self.engine.writes, [])
        self.assertFalse(self.co.ready)
        self.assertEqual(self.store.recover()['version'], 2)
        self.engine.world_id = 'world-a'
        self.co.reconcile()
        self.assertEqual(self.engine.nodes['1,0,0'], 'air')

    def test_wrong_expected_world_rejects_database_even_if_engine_agrees(self):
        self.engine.world_id = 'world-b'
        other = Coordinator(self.store, self.engine, self.nodes, self.actors, world_id='world-b')
        self.engine.writes.clear()
        with self.assertRaises(ReconcileError):
            other.reconcile()
        self.assertEqual(self.engine.writes, [])
        self.assertFalse(other.ready)

    def test_identity_required_and_checked_before_initialization_commit(self):
        for invalid in ('', None, 5):
            with self.subTest(invalid=invalid), self.assertRaises(ReconcileError):
                Coordinator(self.store, self.engine, self.nodes, self.actors, world_id=invalid)
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as root:
            store = WorldStore(Path(root) / 'db', create=True)
            co = Coordinator(store, self.engine, self.nodes, self.actors, world_id='world-b')
            self.engine.writes.clear()
            with self.assertRaises(ReconcileError):
                co.initialize('init', self.engine.nodes.copy(), {'a': {}, 'b': {}})
            self.assertEqual(store.recover()['version'], 0)
            self.assertEqual(self.engine.writes, [])
            store.close()

    def test_engine_world_changed_after_ready_blocks_commit(self):
        self.engine.world_id = 'world-b'
        self.engine.writes.clear()
        with self.assertRaises(ReconcileError):
            self.co.apply('op', 'gather', '1,0,0', 'a')
        self.assertFalse(self.co.ready)
        self.assertEqual(self.store.recover()['version'], 1)
        self.assertEqual(self.engine.writes, [])

    def test_legacy_store_without_world_id_fails_closed(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as root:
            store = WorldStore(Path(root) / 'db', create=True)
            world = {'schema': 1, 'registration': self.nodes, 'nodes': self.engine.nodes.copy()}
            characters = {'a': {'inventory': {}}, 'b': {'inventory': {}}}
            store.commit({'id': 'legacy', 'type': 'resource.init',
                          'data': {'world': world, 'characters': characters}}, 0, world, characters)
            co = Coordinator(store, self.engine, self.nodes, self.actors, world_id='world-a')
            self.engine.writes.clear()
            with self.assertRaises(ReconcileError):
                co.reconcile()
            self.assertEqual(self.engine.writes, [])
            self.assertEqual(store.recover()['world'], world)
            store.close()

    def test_initial_values_must_match(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as root:
            store = WorldStore(Path(root) / 'db', create=True)
            co = Coordinator(store, self.engine, self.nodes, self.actors, world_id='world-a')
            with self.assertRaises(ReconcileError):
                co.initialize('init', {'1,0,0': 'air', '2,0,0': 'ore'}, {'a': {}, 'b': {}})
            self.assertEqual(store.recover()['version'], 0)
            store.close()


if __name__ == '__main__':
    unittest.main()
