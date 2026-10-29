import copy
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from world.origin import OriginError, create_origin_event, draft_sha256, origin_snapshot
from world.origin_store import create_origin
from world.origin_resources import Coordinator, ReconcileError
from world.store import Conflict, CorruptStore, WorldStore


WORLD = '12345678-1234-4234-8234-123456789abc'
OTHER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'


class FakeEngine:
    """Identity belongs to the fixture, not to the creation request or store."""
    def __init__(self, world_id):
        self.world_id = world_id
        self.writes = []
        self.nodes = {'0,0,0': 'ore'}
        self.inventories = {'traveler': {}}

    def get_world_id(self):
        return self.world_id

    def set_node(self, *args):
        self.writes.append(args)
        self.nodes[args[0]] = args[1]

    def set_inventory(self, *args):
        self.writes.append(args)
        self.inventories[args[0]] = copy.deepcopy(args[1])

    def get_node(self, key):
        return self.nodes[key]

    def get_inventory(self, key):
        return copy.deepcopy(self.inventories[key])


class OriginStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.path = Path(self.tmp.name) / 'world.db'
        self.store = WorldStore(self.path, create=True)
        self.engine = FakeEngine(WORLD)
        draft = json.loads((Path(__file__).parent.parent / 'genesis/example.json').read_text(encoding='utf-8'))
        self.ref = {'draft_id': 'draft-1', 'draft_revision': 1,
                    'draft_sha256': draft_sha256(draft), 'operation_id': 'create-1',
                    'status': 'confirmed', 'draft': draft}

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def create(self, ref=None, world_id=WORLD, operation_id='create-1', *, exclusive=False):
        return create_origin(self.store, self.engine, world_id, operation_id,
                             self.ref if ref is None else ref, exclusive=exclusive)

    def register_and_gather(self):
        self.create()
        co = Coordinator(self.store, self.engine, world_id=WORLD, exclusive=True)
        co.register('register', {'0,0,0': 'ore'}, {'0,0,0': 'ore'}, {'traveler': {}})
        co.apply('gather', 2, 'gather', '0,0,0', 'traveler')
        self.engine.writes.clear()

    def test_create_restart_and_identical_retry(self):
        result = {'version': 1, 'event_id': 'create-1'}
        self.assertEqual(self.create(), result)
        event = create_origin_event(WORLD, self.ref)
        world, chars = origin_snapshot(event, WORLD)
        state = self.store.recover()
        self.assertEqual(state, {'version': 1, 'world': world, 'characters': chars,
                                 'clock': {'time': 0, 'paused': True},
                                 'events': [{'version': 1, 'event': event}]})
        self.store.close()
        self.store = WorldStore(self.path)
        self.assertEqual(self.create(copy.deepcopy(self.ref)), result)
        self.assertEqual(self.store.recover(), state)

    def test_lost_response_then_retry(self):
        commit = self.store.commit
        def lost(*args, **kwargs):
            commit(*args, **kwargs)
            raise OSError('response lost')
        self.store.commit = lost
        with self.assertRaises(OSError):
            self.create()
        self.store.commit = commit
        self.store.close()
        self.store = WorldStore(self.path)
        self.assertEqual(self.create(), {'version': 1, 'event_id': 'create-1'})
        self.assertEqual(len(self.store.recover()['events']), 1)

    def test_invalid_input_and_identity_never_commit(self):
        for identity in (None, '', WORLD.upper(), OTHER):
            with self.subTest(identity=identity):
                self.engine.world_id = identity
                with self.assertRaises(OriginError):
                    self.create()
                self.assertEqual(self.store.recover()['version'], 0)
        self.engine.world_id = WORLD
        for kwargs in ({'world_id': 'invalid'}, {'operation_id': 'other'}):
            with self.subTest(kwargs=kwargs), self.assertRaises(OriginError):
                self.create(**kwargs)
        invalid = copy.deepcopy(self.ref)
        invalid['status'] = 'pending'
        with self.assertRaises(OriginError):
            self.create(invalid)
        def broken():
            raise OSError('identity unavailable')
        self.engine.get_world_id = broken
        with self.assertRaises(OriginError):
            self.create()
        self.assertEqual(self.store.recover()['version'], 0)
        self.assertEqual(self.engine.writes, [])

    def test_identity_changes_before_commit(self):
        identities = iter((WORLD, OTHER))
        self.engine.get_world_id = lambda: next(identities)
        with self.assertRaises(OriginError):
            self.create()
        self.assertEqual(self.store.recover()['version'], 0)

    def test_changed_request_and_world_are_rejected(self):
        self.create()
        state = self.store.recover()
        for field, value in [('draft_id', 'another'), ('draft_revision', 2)]:
            ref = copy.deepcopy(self.ref)
            ref[field] = value
            with self.subTest(field=field), self.assertRaises(Conflict):
                self.create(ref)
        ref = copy.deepcopy(self.ref)
        ref['draft']['title'] += '!'
        ref['draft_sha256'] = draft_sha256(ref['draft'])
        with self.assertRaises(Conflict):
            self.create(ref)
        ref = copy.deepcopy(self.ref)
        ref['operation_id'] = 'other'
        with self.assertRaises(Conflict):
            self.create(ref, operation_id='other')
        self.engine.world_id = OTHER
        with self.assertRaises(OriginError):
            self.create(world_id=OTHER)
        self.assertEqual(self.store.recover(), state)

    def test_nonempty_legacy_and_additional_events_rejected(self):
        self.store.commit({'id': 'legacy', 'type': 'resource.init', 'data': {}}, 0, {}, {})
        state = self.store.recover()
        with self.assertRaises(OriginError):
            self.create(exclusive=True)
        self.assertEqual(self.store.recover(), state)

    def test_retry_after_registration_and_action_reconciles(self):
        self.register_and_gather()
        state = self.store.recover()
        self.engine.nodes['0,0,0'] = 'ore'
        self.engine.inventories['traveler'] = {}
        with self.assertRaises(ReconcileError):
            self.create()
        self.assertEqual(self.engine.writes, [])
        self.assertEqual(self.create(exclusive=True), {'version': 1, 'event_id': 'create-1'})
        self.assertEqual(self.engine.nodes, {'0,0,0': 'air'})
        self.assertEqual(self.engine.inventories, {'traveler': {'ore': 1}})
        self.assertEqual(self.store.recover(), state)
        self.store.close()
        self.store = WorldStore(self.path)
        self.assertEqual(self.create(exclusive=True)['version'], 1)

    def test_retry_after_registration(self):
        self.create()
        co = Coordinator(self.store, self.engine, world_id=WORLD, exclusive=True)
        co.register('register', {'0,0,0': 'ore'}, {'0,0,0': 'ore'}, {'traveler': {}})
        self.assertEqual(self.create(exclusive=True), {'version': 1, 'event_id': 'create-1'})
        self.assertEqual(self.engine.writes, [])

    def test_retry_conflict_and_unknown_projection_do_not_write(self):
        self.register_and_gather()
        state = self.store.recover()
        ref = copy.deepcopy(self.ref)
        ref['draft_revision'] = 2
        with self.assertRaises(Conflict):
            self.create(ref, exclusive=True)
        self.engine.nodes['0,0,0'] = 'unknown'
        with self.assertRaises(ReconcileError):
            self.create(exclusive=True)
        self.assertEqual(self.engine.writes, [])
        self.assertEqual(self.store.recover(), state)

    def test_retry_identity_or_projection_read_failure_stays_frozen(self):
        self.register_and_gather()
        state = self.store.recover()
        self.engine.world_id = OTHER
        with self.assertRaises(OriginError):
            self.create(exclusive=True)
        self.engine.world_id = WORLD
        def broken(_key):
            raise OSError('read failed')
        self.engine.get_inventory = broken
        with self.assertRaises(OSError):
            self.create(exclusive=True)
        self.assertEqual(self.engine.writes, [])
        self.assertEqual(self.store.recover(), state)

    def test_retry_rejects_invalid_history_and_initial_request(self):
        self.register_and_gather()
        # Rewrite a past transaction consistently with WorldStore's structural
        # rules: business replay, not the latest snapshot, must reject it.
        row = self.store.db.execute('SELECT request FROM events WHERE version=2').fetchone()
        request = json.loads(row[0])
        request['event']['data']['world_id'] = OTHER
        self.store.db.execute('UPDATE events SET request=? WHERE version=2', (json.dumps(request),))
        with self.assertRaises(ReconcileError):
            self.create(exclusive=True)
        self.assertEqual(self.engine.writes, [])

    def test_retry_rejects_tampered_initial_snapshot_with_later_history(self):
        self.register_and_gather()
        row = self.store.db.execute('SELECT request FROM events WHERE version=1').fetchone()
        request = json.loads(row[0])
        request['characters']['traveler']['goal'] = 'tampered'
        self.store.db.execute('UPDATE events SET request=? WHERE version=1', (json.dumps(request),))
        with self.assertRaises(OriginError):
            self.create(exclusive=True)
        self.assertEqual(self.engine.writes, [])

    def test_projection_failure_then_retry(self):
        self.register_and_gather()
        state = self.store.recover()
        self.engine.nodes['0,0,0'] = 'ore'
        self.engine.inventories['traveler'] = {}
        setter = self.engine.set_node
        def fail_after_write(*args):
            setter(*args)
            raise OSError('projection response lost')
        self.engine.set_node = fail_after_write
        with self.assertRaises(OSError):
            self.create(exclusive=True)
        self.assertEqual(self.store.recover(), state)
        self.engine.set_node = setter
        self.assertEqual(self.create(exclusive=True)['version'], 1)
        self.assertEqual(self.engine.nodes['0,0,0'], 'air')
        self.assertEqual(self.engine.inventories['traveler'], {'ore': 1})

    def test_inconsistent_origin_snapshot_and_clock_rejected(self):
        event = create_origin_event(WORLD, self.ref)
        world, chars = origin_snapshot(event, WORLD)
        world['resources'] = {'unexpected': True}
        self.store.commit(event, 0, world, chars)
        with self.assertRaises(OriginError):
            self.create()
        self.assertEqual(self.store.recover()['version'], 1)

    def test_nonpaused_clock_rejected(self):
        event = create_origin_event(WORLD, self.ref)
        world, chars = origin_snapshot(event, WORLD)
        self.store.commit(event, 0, world, chars, paused=False)
        with self.assertRaises(OriginError):
            self.create()

    def test_original_commit_arguments_are_bound(self):
        event = create_origin_event(WORLD, self.ref)
        world, chars = origin_snapshot(event, WORLD)
        self.store.commit(event, 0, world, chars, paused=True)
        with self.assertRaises(Conflict):
            self.create()
        self.assertEqual(self.store.recover()['version'], 1)

    def test_later_history_is_outside_adapter_scope(self):
        self.create()
        state = self.store.recover()
        self.store.commit({'id': 'later', 'type': 'unknown', 'data': {}}, 1,
                          state['world'], state['characters'])
        state = self.store.recover()
        with self.assertRaises(ReconcileError):
            self.create(exclusive=True)
        self.assertEqual(self.store.recover(), state)

    def test_failed_transaction_has_no_event_and_can_retry(self):
        self.store.db.execute("CREATE TRIGGER reject_origin BEFORE UPDATE ON checkpoint BEGIN SELECT RAISE(ABORT, 'injected'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.create()
        self.assertEqual(self.store.recover()['version'], 0)
        self.store.db.execute('DROP TRIGGER reject_origin')
        self.assertEqual(self.create()['version'], 1)

    def test_corrupt_checkpoint_rejected(self):
        self.create()
        self.store.db.execute("UPDATE checkpoint SET snapshot='{}'")
        with self.assertRaises(CorruptStore):
            self.create()


if __name__ == '__main__':
    unittest.main()
