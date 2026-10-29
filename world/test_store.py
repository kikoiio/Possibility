import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from world.store import WorldStore, Conflict, CorruptStore


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.path = Path(self.tmp.name) / 'world.db'
        self.store = WorldStore(self.path, create=True)

    def tearDown(self):
        if self.store:
            self.store.close()
        self.tmp.cleanup()

    def commit(self, id, version, world=None, characters=None, **kwargs):
        return self.store.commit({'id': id, 'type': 'change', 'data': {'value': id}}, version,
                                 world or {}, characters or {}, **kwargs)

    def test_restart_idempotency_and_conflict(self):
        world = {'resources': {'tree': 2}}
        actors = {'agent:one': {'pos': {'x': 1}, 'memory': ['met']}}
        result = self.commit('resume', 0, world, actors, paused=False)
        self.commit('take', 1, {'resources': {'tree': 1}}, actors, elapsed=2.5)
        self.store.close()
        self.store = WorldStore(self.path)
        self.assertEqual(self.commit('resume', 0, world, actors, paused=False), result)
        state = self.store.recover()
        self.assertEqual((state['version'], state['clock']['time']), (2, 2.5))
        self.assertEqual(state['characters'], actors)
        self.assertEqual([e['event']['id'] for e in state['events']], ['resume', 'take'])
        with self.assertRaises(Conflict):
            self.commit('resume', 0, {'different': True}, actors, paused=False)
        with self.assertRaises(Conflict):
            self.commit('stale', 0)
        self.assertEqual(self.store.recover(), state)

    def test_time_freezes_at_pause_and_restart(self):
        with self.assertRaises(Conflict):
            self.commit('bad', 0, elapsed=1)
        self.commit('start', 0, paused=False)
        self.commit('pause', 1, elapsed=10, paused=True)
        with self.assertRaises(Conflict):
            self.commit('waiting', 2, elapsed=3, paused=False)
        self.store.close()
        self.store = WorldStore(self.path)
        self.assertEqual(self.store.recover()['clock'], {'time': 10, 'paused': True})
        self.commit('continue', 2, paused=False)
        self.assertEqual(self.store.recover()['clock']['time'], 10)

    def test_atomic_failure_and_retry(self):
        self.store.db.execute("CREATE TRIGGER reject_update BEFORE UPDATE ON checkpoint BEGIN SELECT RAISE(ABORT, 'injected'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.commit('failed', 0, {'changed': True})
        self.assertEqual(self.store.recover()['version'], 0)
        self.store.db.execute('DROP TRIGGER reject_update')
        self.assertEqual(self.commit('failed', 0, {'changed': True})['version'], 1)

    def test_interrupted_uncommitted_write_rolls_back(self):
        self.store.db.execute('BEGIN IMMEDIATE')
        self.store.db.execute("UPDATE checkpoint SET version=1")
        self.store.close()
        self.store = WorldStore(self.path)
        self.assertEqual(self.store.recover()['version'], 0)
        self.assertEqual(self.store.recover()['events'], [])

    def test_corruption_fails_closed(self):
        self.commit('one', 0, {'v': 1})
        self.store.db.execute("UPDATE checkpoint SET snapshot='{}'")
        with self.assertRaises(CorruptStore):
            self.store.recover()
        self.store.close()
        self.store = None
        with self.assertRaises(CorruptStore):
            WorldStore(self.path)
        db = sqlite3.connect(self.path)
        self.assertEqual(db.execute('SELECT snapshot FROM checkpoint').fetchone()[0], '{}')
        db.close()

    def test_valid_but_mismatching_snapshot_and_history_rejected(self):
        self.commit('one', 0, {'v': 1})
        snapshot = {'world': {'v': 2}, 'characters': {}, 'clock': {'time': 0, 'paused': True}}
        self.store.db.execute('UPDATE checkpoint SET snapshot=?', (json.dumps(snapshot),))
        with self.assertRaises(CorruptStore):
            self.store.recover()

    def test_persisted_json_ambiguities_fail_closed(self):
        self.commit('one', 0, {'v': 1})
        locations = (('checkpoint', 'snapshot'), ('events', 'request'), ('events', 'result'))
        prefixes = ('"duplicate":0,"duplicate":1,',
                    '"probe":{"duplicate":0,"duplicate":1},',
                    '"probe":NaN,', '"probe":Infinity,', '"probe":-Infinity,',
                    '"probe":1e999,')
        for table, column in locations:
            original = self.store.db.execute(f'SELECT {column} FROM {table}').fetchone()[0]
            for prefix in prefixes:
                with self.subTest(table=table, column=column, prefix=prefix):
                    damaged = '{' + prefix + original[1:]
                    self.store.db.execute(f'UPDATE {table} SET {column}=?', (damaged,))
                    with self.assertRaises(CorruptStore):
                        self.store.recover()
                    self.assertFalse(self.store.db.in_transaction)
                    with self.assertRaises(CorruptStore):
                        WorldStore(self.path)
                    self.assertEqual(self.store.db.execute(
                        f'SELECT {column} FROM {table}').fetchone()[0], damaged)
                    self.store.db.execute(f'UPDATE {table} SET {column}=?', (original,))

    def test_commit_rejects_corrupt_persisted_json(self):
        self.commit('one', 0, {'v': 1})
        for table, column, operation in (
                ('events', 'request', lambda: self.commit('one', 0, {'v': 1})),
                ('events', 'result', lambda: self.commit('one', 0, {'v': 1})),
                ('checkpoint', 'snapshot', lambda: self.commit('two', 1))):
            original = self.store.db.execute(f'SELECT {column} FROM {table}').fetchone()[0]
            for prefix in ('"nested":{"x":1,"x":2},', '"bad":NaN,'):
                with self.subTest(column=column, prefix=prefix):
                    damaged = '{' + prefix + original[1:]
                    self.store.db.execute(f'UPDATE {table} SET {column}=?', (damaged,))
                    with self.assertRaises(CorruptStore):
                        operation()
                    self.assertFalse(self.store.db.in_transaction)
                    self.assertEqual(self.store.db.execute('SELECT count(*) FROM events').fetchone()[0], 1)
                    self.assertEqual(self.store.db.execute(
                        f'SELECT {column} FROM {table}').fetchone()[0], damaged)
                    self.store.db.execute(f'UPDATE {table} SET {column}=?', (original,))

    def test_valid_legacy_json_formatting_is_accepted(self):
        result = self.commit('one', 0, {'v': 1})
        for table, column in (('checkpoint', 'snapshot'), ('events', 'result')):
            original = self.store.db.execute(f'SELECT {column} FROM {table}').fetchone()[0]
            self.store.db.execute(f'UPDATE {table} SET {column}=?',
                                  (json.dumps(json.loads(original), indent=2),))
        self.store.close()
        self.store = WorldStore(self.path)
        self.assertEqual(self.store.recover()['version'], 1)
        self.assertEqual(self.commit('one', 0, {'v': 1}), result)

    def test_invalid_event_result_rejected_on_replay_and_retry(self):
        self.commit('one', 0, {'v': 1})
        self.commit('two', 1, {'v': 2})
        original = self.store.db.execute(
            "SELECT result FROM events WHERE event_id='one'").fetchone()[0]
        invalid_results = (
            {'version': True, 'event_id': 'one'},
            {'version': 1.0, 'event_id': 'one'},
            {'version': 2, 'event_id': 'one'},
            {'version': 1, 'event_id': 'one', 'extra': 0},
            {'version': 1},
            {'version': 1, 'event_id': 'two'},
            {'version': 1, 'event_id': 1},
        )
        for invalid in invalid_results:
            with self.subTest(result=invalid):
                damaged = json.dumps(invalid)
                self.store.db.execute("UPDATE events SET result=? WHERE event_id='one'", (damaged,))
                with self.assertRaises(CorruptStore):
                    self.commit('one', 0, {'v': 1})
                self.assertFalse(self.store.db.in_transaction)
                with self.assertRaises(CorruptStore):
                    self.store.recover()
                self.assertFalse(self.store.db.in_transaction)
                with self.assertRaises(CorruptStore):
                    WorldStore(self.path)
                self.assertEqual(self.store.db.execute(
                    "SELECT result FROM events WHERE event_id='one'").fetchone()[0], damaged)
                self.assertEqual(self.store.db.execute('SELECT count(*) FROM events').fetchone()[0], 2)
                self.store.db.execute("UPDATE events SET result=? WHERE event_id='one'", (original,))
        self.assertEqual(self.commit('one', 0, {'v': 1}), {'version': 1, 'event_id': 'one'})
        self.assertEqual(self.store.recover()['version'], 2)

    def test_validation_and_schema(self):
        with self.assertRaises(ValueError):
            self.commit('x', 0, {'bad': float('nan')})
        with self.assertRaises(ValueError):
            self.commit('x', 0, characters={'': {}})
        with self.assertRaises(ValueError):
            self.commit('x', 0, characters={'a': []})
        self.store.db.execute('PRAGMA user_version=2')
        with self.assertRaises(CorruptStore):
            self.store.recover()

    def test_two_writers_use_version_check(self):
        other = WorldStore(self.path)
        try:
            self.commit('first', 0)
            with self.assertRaises(Conflict):
                other.commit({'id': 'second', 'type': 'change', 'data': {}}, 0, {}, {})
            self.assertEqual(other.recover()['version'], 1)
        finally:
            other.close()

    def test_no_implicit_create(self):
        with self.assertRaises(sqlite3.OperationalError):
            WorldStore(self.path.parent / 'missing.db')
        empty = self.path.parent / 'empty.db'
        sqlite3.connect(empty).close()
        with self.assertRaises(CorruptStore):
            WorldStore(empty)


if __name__ == '__main__':
    unittest.main()
