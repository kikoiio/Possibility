import json
import os
import select
import sqlite3
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from genesis.origin_confirmation import OriginConfirmation
from genesis.store import DraftConflict, DraftStore
from world.origin_store import create_origin
from world.store import WorldStore


WORLD = '12345678-1234-4234-8234-123456789abc'
OTHER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'


class Engine:
    def get_world_id(self):
        return WORLD


class OriginConfirmationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.root = Path(self.temp.name)
        self.draft_path = self.root / 'drafts.sqlite'
        self.path = self.root / 'world.sqlite'
        self.drafts = DraftStore(self.draft_path, create=True)
        draft = json.loads((Path(__file__).parent / 'example.json').read_text(encoding='utf-8'))
        self.row = self.drafts.create(draft)
        self.store = WorldStore(self.path, create=True)
        self.bridge = OriginConfirmation(self.drafts)
        self.engine = Engine()
        self.args = (WORLD, 'create-1', self.row['id'], 1, str(self.path))

    def tearDown(self):
        self.store.close()
        self.drafts.close()
        self.temp.cleanup()

    def reopen(self):
        self.store.close()
        self.drafts.close()
        self.drafts = DraftStore(self.draft_path)
        self.store = WorldStore(self.path)
        self.bridge = OriginConfirmation(self.drafts)

    def create(self, *args):
        return self.bridge.create(self.store, self.engine, *(args or self.args))

    def test_requires_persisted_confirmation_and_is_idempotent(self):
        with self.assertRaises(DraftConflict):
            self.create()
        with self.assertRaises(TypeError):
            self.bridge.confirm(*self.args, status='confirmed')
        binding = self.bridge.confirm(*self.args)
        self.assertEqual(self.bridge.confirm(*self.args), binding)
        self.assertEqual(self.create(), {'version': 1, 'event_id': 'create-1'})
        self.reopen()
        self.assertEqual(self.bridge.confirm(*self.args), binding)
        self.assertEqual(self.create(), {'version': 1, 'event_id': 'create-1'})
        event = self.store.recover()['events'][0]['event']
        self.assertEqual(event['data']['draft_sha256'], binding['draft_sha256'])
        self.assertEqual(event['data']['origin']['draft'], self.row['draft'])
        self.assertEqual(self.drafts.read(self.row['id'])['status'], 'draft')

    def test_different_bindings_and_target_store_rejected(self):
        self.bridge.confirm(*self.args)
        other_path = self.root / 'other.sqlite'
        other_store = WorldStore(other_path, create=True)
        try:
            for args in ((OTHER, *self.args[1:]), (WORLD, 'other', *self.args[2:]),
                         (*self.args[:4], str(other_path)), (*self.args[:3], 2, self.args[4])):
                with self.subTest(args=args), self.assertRaises((DraftConflict, KeyError)):
                    self.bridge.confirm(*args)
                with self.assertRaises(DraftConflict):
                    self.create(*args)
            with self.assertRaises(DraftConflict):
                self.bridge.create(other_store, self.engine, *self.args)
            self.assertEqual(other_store.recover()['version'], 0)
        finally:
            other_store.close()
        self.assertEqual(self.store.recover()['version'], 0)

    def test_confirmation_freezes_draft_across_restart_and_completion(self):
        changed = self.row['draft'].copy()
        changed['title'] = 'changed before confirmation'
        updated = self.drafts.update(self.row['id'], 1, changed)
        self.args = (*self.args[:3], updated['revision'], self.args[4])
        self.bridge.confirm(*self.args)
        for completed in (False, True):
            self.reopen()
            with self.assertRaises(DraftConflict): self.drafts.update(self.row['id'], 2, changed)
            with self.assertRaises(DraftConflict): self.drafts.confirm(self.row['id'], 2, self.root / 'legacy.sqlite')
            with self.assertRaises(DraftConflict): self.drafts.recover_confirmation(self.row['id'])
            self.assertFalse((self.root / 'legacy.sqlite').exists())
            self.bridge.confirm(*self.args)
            if not completed: self.create()
        self.assertEqual(self.drafts.read(self.row['id'])['revision'], 2)

    def test_draft_cannot_bind_to_another_world_or_operation(self):
        self.bridge.confirm(*self.args)
        other = self.root / 'other.sqlite'
        store = WorldStore(other, create=True)
        try:
            with self.assertRaises(DraftConflict):
                self.bridge.confirm(OTHER, 'other', self.row['id'], 1, str(other))
        finally:
            store.close()

    def test_invalid_targets_leave_bytes_and_draft_unchanged(self):
        plain = self.root / 'not-sqlite'
        plain.write_bytes(b'not a database\x00')
        arbitrary = self.root / 'other-db.sqlite'
        db = sqlite3.connect(arbitrary)
        try:
            db.execute('CREATE TABLE other (value TEXT)')
            db.commit()
        finally:
            db.close()
        occupied = self.root / 'occupied.sqlite'
        world = WorldStore(occupied, create=True)
        world.commit({'id': 'unrelated', 'type': 'other', 'data': {}}, 0, {}, {})
        world.close()
        corrupted = self.root / 'corrupted.sqlite'
        world = WorldStore(corrupted, create=True)
        world.db.execute("UPDATE checkpoint SET snapshot='{}'")
        world.close()
        hardlink = self.root / 'draft-hardlink.sqlite'
        os.link(self.draft_path, hardlink)
        sidecar = self.root / 'sidecar.sqlite'
        world = WorldStore(sidecar, create=True)
        world.close()
        journal = Path(str(sidecar) + '-journal')
        journal.write_bytes(b'journal data')

        for target in (plain, arbitrary, occupied, corrupted, hardlink, sidecar):
            with self.subTest(target=target):
                before = target.read_bytes()
                journal_before = journal.read_bytes()
                with self.assertRaises(DraftConflict):
                    self.bridge.confirm(*self.args[:4], str(target))
                self.assertEqual(target.read_bytes(), before)
                self.assertEqual(journal.read_bytes(), journal_before)
                self.assertEqual(self.drafts.db.execute('SELECT COUNT(*) FROM origin_confirmations_v1').fetchone()[0], 0)
                row = self.drafts.read(self.row['id'])
                updated = self.drafts.update(row['id'], row['revision'], row['draft'])
                self.args = (*self.args[:3], updated['revision'], self.args[4])

    def test_direct_database_mutation_still_fails_closed(self):
        self.bridge.confirm(*self.args)
        self.drafts.db.execute('UPDATE drafts SET revision=revision+1 WHERE id=?', (self.row['id'],))
        self.reopen()
        with self.assertRaises(DraftConflict): self.create()
        with self.assertRaises(DraftConflict): self.bridge.confirm(*self.args)
        self.assertEqual(self.store.recover()['version'], 0)

    def test_cross_process_write_lock_orders_confirmation_and_update(self):
        script = '''
import sys
from genesis.store import DraftStore, DraftConflict
from genesis.origin_confirmation import OriginConfirmation
db, mode, world, op, ident, target = sys.argv[1:]
s = DraftStore(db)
b = OriginConfirmation(s)
draft = s.read(ident)['draft']
draft['title'] = 'child update'
print('ready', flush=True)
sys.stdin.readline()
try:
    if mode == 'update': s.update(ident, 1, draft)
    elif mode == 'legacy': s.confirm(ident, 1, target + '.legacy')
    else: b.confirm(world, op, ident, 1, target)
except DraftConflict:
    print('conflict', flush=True)
else:
    print('success', flush=True)
finally:
    s.close()
'''
        def start_contender(mode):
            process = subprocess.Popen([sys.executable, '-u', '-c', script, str(self.draft_path), mode,
                                        WORLD, 'create-1', self.row['id'], str(self.path)],
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, text=True)
            self.assertEqual(process.stdout.readline().strip(), 'ready')
            self.addCleanup(lambda: process.kill() if process.poll() is None else None)
            return process

        def compete(process):
            process.stdin.write('go\n')
            process.stdin.flush()
            # The parent has already acquired BEGIN IMMEDIATE in action's _row.
            self.assertFalse(select.select([process.stdout], [], [], 0.2)[0])

        original = self.drafts._row
        contender = start_contender('update')
        legacy = start_contender('legacy')
        def during_confirm(ident):
            row = original(ident)
            compete(contender)
            compete(legacy)
            return row
        with patch.object(self.drafts, '_row', side_effect=during_confirm):
            self.bridge.confirm(*self.args)
        out, err = contender.communicate(timeout=5)
        self.assertEqual((contender.returncode, out.strip(), err), (0, 'conflict', ''))
        out, err = legacy.communicate(timeout=5)
        self.assertEqual((legacy.returncode, out.strip(), err), (0, 'conflict', ''))
        self.assertFalse(Path(str(self.path) + '.legacy').exists())
        self.assertEqual(self.drafts.read(self.row['id'])['revision'], 1)

        # A second draft shows the reverse ordering: update commits first and the
        # waiting confirmation sees a stale revision, so it cannot freeze it.
        second = self.drafts.create(self.row['draft'])
        first_row, first_args = self.row, self.args
        self.row = second
        self.args = (WORLD, 'create-1', second['id'], 1, str(self.path))
        contender = start_contender('confirm')
        started = False
        def during_update(ident):
            nonlocal started
            row = original(ident)
            if not started:
                started = True
                compete(contender)
            return row
        changed = second['draft'].copy()
        changed['title'] = 'parent update'
        try:
            with patch.object(self.drafts, '_row', side_effect=during_update):
                self.drafts.update(second['id'], 1, changed)
            out, err = contender.communicate(timeout=5)
            self.assertEqual((contender.returncode, out.strip(), err), (0, 'conflict', ''))
            self.assertEqual(self.drafts.read(second['id'])['revision'], 2)
        finally:
            self.row, self.args = first_row, first_args

    def test_recovery_after_world_commit_before_bridge_commit(self):
        self.bridge.confirm(*self.args)
        def interrupted(*args, **kwargs):
            create_origin(*args, **kwargs)
            raise OSError('response lost after world commit')
        with patch('genesis.origin_confirmation.create_origin', side_effect=interrupted):
            with self.assertRaises(OSError): self.create()
        self.assertEqual(self.store.recover()['version'], 1)
        self.assertEqual(self.drafts.db.execute('SELECT phase FROM origin_confirmations_v1').fetchone()[0], 'pending')
        self.reopen()
        self.bridge.confirm(*self.args)
        self.assertEqual(self.create()['version'], 1)
        self.assertEqual(self.drafts.db.execute('SELECT phase FROM origin_confirmations_v1').fetchone()[0], 'complete')

    def test_bridge_commit_failure_recovers_committed_world(self):
        self.bridge.confirm(*self.args)
        self.drafts.db.execute("CREATE TRIGGER reject_completion BEFORE UPDATE ON origin_confirmations_v1 BEGIN SELECT RAISE(ABORT, 'injected'); END")
        with self.assertRaises(sqlite3.IntegrityError): self.create()
        self.assertEqual(self.store.recover()['version'], 1)
        self.drafts.db.execute('DROP TRIGGER reject_completion')
        self.reopen()
        self.assertEqual(self.create()['version'], 1)

    def test_failure_before_world_commit_is_retryable(self):
        self.bridge.confirm(*self.args)
        with patch('genesis.origin_confirmation.create_origin', side_effect=OSError('failed')):
            with self.assertRaises(OSError): self.create()
        self.reopen()
        self.assertEqual(self.create()['version'], 1)

    def test_corrupt_binding_fails_closed(self):
        self.bridge.confirm(*self.args)
        self.drafts.db.execute("UPDATE origin_confirmations_v1 SET digest='bad'")
        with self.assertRaises(DraftConflict): self.create()
        self.assertEqual(self.store.recover()['version'], 0)

    def test_completed_world_cannot_be_silently_recreated(self):
        self.bridge.confirm(*self.args)
        self.create()
        self.store.close()
        self.path.unlink()
        self.store = WorldStore(self.path, create=True)
        with self.assertRaises(DraftConflict): self.create()
        self.assertEqual(self.store.recover()['version'], 0)

    def test_legacy_pending_is_not_v1_confirmation(self):
        with patch.object(self.drafts, '_publish', side_effect=OSError('stop')):
            with self.assertRaises(OSError):
                self.drafts.confirm(self.row['id'], 1, self.root / 'legacy.sqlite')
        with self.assertRaises(DraftConflict): self.create()
        with self.assertRaises(DraftConflict): self.bridge.confirm(*self.args)


if __name__ == '__main__':
    unittest.main()
