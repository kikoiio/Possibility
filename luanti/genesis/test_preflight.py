import tempfile
import unittest
from pathlib import Path

from luanti.genesis.preflight import PreflightError, preflight
from luanti.genesis.store import DraftConflict, DraftStore
from luanti.genesis.test_genesis import draft
from luanti.world.store import WorldStore


class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.store = DraftStore(self.root / 'drafts.sqlite', create=True)
        self.origin = self.root / 'origin.sqlite'
        self.runtime = self.root / 'new-runtime'

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def confirmed(self, value=None):
        row = self.store.create(draft() if value is None else value)
        self.store.confirm(row['id'], row['revision'], self.origin)
        return row

    def test_explicit_confirmation_and_revision_required(self):
        row = self.store.create(draft())
        with self.assertRaises(PreflightError) as e: preflight(self.store, row['id'], 1, self.runtime)
        self.assertEqual(e.exception.code, 'confirmation_mismatch')
        self.store.confirm(row['id'], 1, self.origin)
        with self.assertRaises(PreflightError) as e: preflight(self.store, row['id'], 2, self.runtime)
        self.assertEqual(e.exception.code, 'confirmation_mismatch')
        self.assertFalse(self.runtime.exists())

    def test_confirmed_origin_is_inspected_without_creating_runtime(self):
        row = self.confirmed()
        before = self.origin.read_bytes()
        result = preflight(self.store, row['id'], 1, self.runtime)
        self.assertEqual(result['status'], 'blocked')
        self.assertFalse(result['launchable'])
        self.assertEqual(result['plan']['private_actors']['a']['memory_seeds'], ['私人的经历'])
        self.assertEqual(self.origin.read_bytes(), before)
        self.assertFalse(self.runtime.exists())
        self.assertEqual(self.store.read(row['id'])['status'], 'confirmed')

    def test_unsupported_content_fails_closed(self):
        d = draft()
        d['rules'] = [{'id': 'r', 'description': 'rule'}]
        d['layout']['places'][0]['space'] = 'indoor'
        d['places'].append({'id': 'hill', 'name': 'Hill', 'description': 'Hill'})
        d['layout']['places'].append({'placeId': 'hill', 'space': 'outdoor', 'grid': [1, 0]})
        d['layout']['connections'].append({'from': 'bank', 'to': 'hill'})
        row = self.confirmed(d)
        with self.assertRaises(PreflightError) as e: preflight(self.store, row['id'], 1, self.runtime)
        self.assertEqual({x['code'] for x in e.exception.diagnostics}, {'descriptive_rules_unsupported', 'indoor_terrain_unsupported', 'connections_unsupported'})
        self.assertFalse(self.runtime.exists())

    def test_existing_runtime_and_symlink_refused(self):
        row = self.confirmed()
        self.runtime.mkdir()
        with self.assertRaises(PreflightError) as e: preflight(self.store, row['id'], 1, self.runtime)
        self.assertEqual(e.exception.code, 'runtime_path_exists')
        self.runtime.rmdir()
        self.runtime.symlink_to(self.root / 'missing')
        with self.assertRaises(PreflightError) as e: preflight(self.store, row['id'], 1, self.runtime)
        self.assertEqual(e.exception.code, 'runtime_path_exists')

    def test_origin_missing_changed_or_advanced(self):
        row = self.confirmed()
        world = WorldStore(self.origin)
        try:
            state = world.recover()
            world.commit({'id':'next', 'type':'changed', 'data':{}}, 1, state['world'], state['characters'])
        finally: world.close()
        with self.assertRaises(PreflightError) as e: preflight(self.store, row['id'], 1, self.runtime)
        self.assertEqual(e.exception.code, 'world_already_advanced')
        self.origin.unlink()
        with self.assertRaises(PreflightError) as e: preflight(self.store, row['id'], 1, self.runtime)
        self.assertEqual(e.exception.code, 'confirmed_world_missing')

    def test_corrupt_checkpoint_and_unconfirmed_pending_fail_closed(self):
        row = self.store.create(draft())
        self.origin.write_bytes(b'unrelated')
        with self.assertRaises(DraftConflict): self.store.confirm(row['id'], 1, self.origin)
        with self.assertRaises(PreflightError) as e: preflight(self.store, row['id'], 1, self.runtime)
        self.assertEqual(e.exception.code, 'confirmation_mismatch')
        self.origin.unlink()
        self.store.recover_confirmation(row['id'])
        world = WorldStore(self.origin)
        try: world.db.execute("UPDATE checkpoint SET snapshot='{}'")
        finally: world.close()
        before = self.origin.read_bytes()
        with self.assertRaises(PreflightError) as e: preflight(self.store, row['id'], 1, self.runtime)
        self.assertEqual(e.exception.code, 'confirmed_world_invalid')
        self.assertEqual(self.origin.read_bytes(), before)
        self.assertFalse(self.runtime.exists())

    def test_compiler_bounds_are_enforced(self):
        d = draft(); d['layout']['places'][0]['grid'] = [5, 0]
        row = self.confirmed(d)
        with self.assertRaises(PreflightError) as e: preflight(self.store, row['id'], 1, self.runtime)
        self.assertEqual(e.exception.code, 'out_of_bounds')

if __name__ == '__main__': unittest.main()
