import os
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from genesis.store import DraftStore, DraftConflict, DraftCorrupt
from genesis.test_genesis import draft
from world.store import WorldStore


class DraftStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.path = self.root / 'drafts.sqlite'
        self.target = self.root / 'world.sqlite'
        self.s = DraftStore(self.path, create=True)

    def tearDown(self):
        self.s.close()
        self.temp.cleanup()

    def reopen(self):
        self.s.close()
        self.s = DraftStore(self.path)

    def test_create_update_confirm_and_projection(self):
        d = draft(); d['rules'] = [{'id': 'r', 'description': 'A rule'}]
        row = self.s.create(d); ident = row['id']
        self.assertFalse(self.target.exists())
        newer = draft(); newer['rules'] = d['rules']; newer['title'] = '新河谷'
        self.s.update(ident, 1, newer)
        with self.assertRaises(DraftConflict): self.s.confirm(ident, 1, self.target)
        self.assertFalse(self.target.exists())
        self.reopen()
        result = self.s.confirm(ident, 2, self.target)
        self.assertIn({'code': 'descriptive_rule_not_implemented', 'rule_id': 'r'}, result['unsupported'])
        self.assertIn({'code': 'luanti_map_not_integrated'}, result['unsupported'])
        world = WorldStore(self.target)
        try: state = world.recover()
        finally: world.close()
        self.assertEqual(state['version'], 1)
        self.assertEqual(state['clock'], {'time': 0, 'paused': True})
        self.assertNotIn('rules', state['world']['genesis'])
        self.assertFalse(state['world']['genesis']['map_applied'])
        self.assertEqual(state['characters']['a']['memory_seeds'], ['私人的经历'])
        self.assertEqual(state['characters']['a']['goal'], '找到住处')
        self.assertNotIn('私人的经历', str(state['world']))
        self.assertNotIn('goal', str(state['world']))
        with self.assertRaises(DraftConflict): self.s.update(ident, 2, draft())
        self.assertEqual(self.s.confirm(ident, 2, self.target), result)

    def test_existing_file_is_untouched(self):
        self.target.write_bytes(b'original file\x00')
        ident = self.s.create(draft())['id']
        with self.assertRaises(DraftConflict): self.s.confirm(ident, 1, self.target)
        self.assertEqual(self.target.read_bytes(), b'original file\x00')
        self.assertEqual(self.s.read(ident)['status'], 'pending')
        with self.assertRaises(DraftConflict): self.s.confirm(ident, 1, self.root / 'other')
        self.target.unlink()
        self.assertEqual(self.s.recover_confirmation(ident)['status'], 'confirmed')

    def test_failure_before_and_after_publish_recover(self):
        ident = self.s.create(draft())['id']
        with patch('genesis.store.os.link', side_effect=OSError('injected')):
            with self.assertRaises(OSError): self.s.confirm(ident, 1, self.target)
        self.assertFalse(self.target.exists())
        self.assertEqual(self.s.read(ident)['status'], 'pending')
        self.assertFalse(list(self.root.glob('.genesis-*')))
        self.reopen()
        calls = []
        def fail_after_link(path):
            calls.append(path)
            raise OSError('injected after link')
        with patch('genesis.store._sync_dir', side_effect=fail_after_link):
            with self.assertRaises(OSError): self.s.recover_confirmation(ident)
        self.assertTrue(self.target.exists())
        self.assertEqual(self.s.read(ident)['status'], 'pending')
        self.reopen()
        self.assertEqual(self.s.recover_confirmation(ident)['status'], 'confirmed')
        self.assertEqual(self.s.read(ident)['status'], 'confirmed')

    def test_conflicting_writers_and_no_implicit_confirm(self):
        ident = self.s.create(draft())['id']
        other = DraftStore(self.path)
        try:
            other.update(ident, 1, draft())
            with self.assertRaises(DraftConflict): self.s.update(ident, 1, draft())
            with self.assertRaises(DraftConflict): self.s.recover_confirmation(ident)
            self.assertFalse(self.target.exists())
        finally: other.close()

    def test_existing_world_and_corrupt_draft_fail_closed(self):
        existing = WorldStore(self.target, create=True)
        try:
            existing.commit({'id':'old', 'type':'old', 'data':{}}, 0, {'original':True}, {})
            before = existing.recover()
        finally: existing.close()
        before_bytes = self.target.read_bytes()
        ident = self.s.create(draft())['id']
        with self.assertRaises(DraftConflict): self.s.confirm(ident, 1, self.target)
        self.assertEqual(before_bytes, self.target.read_bytes())
        existing = WorldStore(self.target)
        try: self.assertEqual(before, existing.recover())
        finally: existing.close()
        self.s.db.execute('UPDATE drafts SET payload=? WHERE id=?', ('{}', ident))
        with self.assertRaises(DraftCorrupt): self.s.recover_confirmation(ident)

    def test_process_crash_after_link_and_reopen(self):
        ident = self.s.create(draft())['id']
        self.s.close()
        script = """import os, sys
from genesis.store import DraftStore
from unittest.mock import patch
original = os.link
def crash(src, dst):
    original(src, dst)
    os._exit(73)
s = DraftStore(sys.argv[1])
with patch('genesis.store.os.link', side_effect=crash):
    s.confirm(sys.argv[2], 1, sys.argv[3])
"""
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1')
        result = subprocess.run([sys.executable, '-c', script, str(self.path), ident, str(self.target)], env=env, check=False)
        self.s = DraftStore(self.path)
        self.assertEqual(result.returncode, 73)
        self.assertEqual(self.s.read(ident)['status'], 'pending')
        self.assertEqual(self.s.recover_confirmation(ident)['status'], 'confirmed')
        restored = WorldStore(self.target)
        try: self.assertEqual(restored.recover()['version'], 1)
        finally: restored.close()

    def test_race_does_not_overwrite_competing_file(self):
        ident = self.s.create(draft())['id']
        original = os.link
        def compete(src, dst):
            Path(dst).write_bytes(b'competitor')
            original(src, dst)
        with patch('genesis.store.os.link', side_effect=compete):
            with self.assertRaises(DraftConflict): self.s.confirm(ident, 1, self.target)
        self.assertEqual(self.target.read_bytes(), b'competitor')

    def test_explicit_create_never_overwrites_existing_draft_db(self):
        before = self.path.read_bytes()
        with self.assertRaises(FileExistsError): DraftStore(self.path, create=True)
        self.assertEqual(self.path.read_bytes(), before)

if __name__ == '__main__': unittest.main()
