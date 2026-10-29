"""Controlled session tests; these do not start or integrate real Luanti.

Identity authentication, authorization and uncooperative writers remain the
caller's responsibility, outside this cooperative locking protocol.
"""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import uuid

from engine.luanti import world_identity as identity
from engine.luanti import world_lock as locks
from engine.luanti import world_session as sessions


@unittest.skipUnless(locks.fcntl is not None and hasattr(os, 'O_NOFOLLOW'),
                     'requires Unix flock and O_NOFOLLOW')
class WorldSessionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.world = Path(self.tmp.name)
        self.path = self.world / identity.IDENTITY_FILE

    def probe_process(self):
        result = subprocess.run(
            [sys.executable, '-B', '-c',
             'import sys\n'
             'from engine.luanti.world_session import WorldSession\n'
             'try:\n'
             '    with WorldSession(sys.argv[1], create=True):\n'
             '        print("entered")\n'
             'except BlockingIOError:\n'
             '    print("busy")\n', str(self.world)],
            cwd=Path(__file__).resolve().parents[2],
            capture_output=True, text=True, timeout=10, check=True)
        return result.stdout.strip()

    def assert_released(self):
        with locks.WorldLock(self.world):
            pass

    def test_create_and_restore_without_overwriting(self):
        with sessions.WorldSession(self.world, create=True) as session:
            world_id = session.world_id
            self.assertEqual(str(uuid.UUID(world_id)), world_id)
            self.assertEqual(identity.read_world_identity(self.world), world_id)
            self.assertEqual(set(p.name for p in self.world.iterdir()),
                             {identity.IDENTITY_FILE, locks.LOCK_FILE})
        self.assertIsNone(session.world_id)
        original = self.path.stat()
        (self.world / 'map.sqlite').write_bytes(b'existing world')
        for create in (False, True):
            with sessions.WorldSession(self.world, create=create,
                                       expected_world_id=world_id) as restored:
                self.assertEqual(restored.world_id, world_id)
            self.assertEqual(self.path.stat().st_ino, original.st_ino)
            self.assertEqual(self.path.stat().st_mtime_ns, original.st_mtime_ns)
        self.assert_released()

    def test_missing_identity_requires_create(self):
        with self.assertRaises(FileNotFoundError):
            with sessions.WorldSession(self.world):
                self.fail('missing world entered')
        self.assertFalse(self.path.exists())
        self.assert_released()

    def test_nonempty_unidentified_world_is_rejected(self):
        for name in ('map.sqlite', '.hidden', 'subdirectory'):
            with self.subTest(name=name):
                entry = self.world / name
                if name == 'subdirectory':
                    entry.mkdir()
                else:
                    entry.write_bytes(b'existing')
                with self.assertRaisesRegex(ValueError, 'non-empty'):
                    with sessions.WorldSession(self.world, create=True):
                        self.fail('non-empty world entered')
                self.assertFalse(self.path.exists())
                self.assert_released()
                if entry.is_dir():
                    entry.rmdir()
                else:
                    entry.unlink()

    def test_wrong_expected_identity_preserves_existing_identity(self):
        world_id = identity.create_world_identity(self.world)
        for create in (False, True):
            with self.subTest(create=create):
                with self.assertRaisesRegex(ValueError, 'expected_world_id'):
                    with sessions.WorldSession(self.world, create=create,
                                               expected_world_id=str(uuid.uuid4())):
                        self.fail('wrong identity entered')
                self.assertEqual(identity.read_world_identity(self.world), world_id)
                self.assert_released()

    def test_expected_identity_on_empty_world_does_not_create(self):
        with self.assertRaisesRegex(ValueError, 'missing'):
            with sessions.WorldSession(self.world, create=True,
                                       expected_world_id=str(uuid.uuid4())):
                self.fail('unidentified world entered')
        self.assertFalse(self.path.exists())
        self.assert_released()

    def test_corrupt_identity_is_never_replaced(self):
        self.path.write_bytes(b'corrupt')
        with self.assertRaises(ValueError):
            with sessions.WorldSession(self.world, create=True):
                self.fail('corrupt identity entered')
        self.assertEqual(self.path.read_bytes(), b'corrupt')
        self.assert_released()

    def test_identity_symlink_is_rejected_without_replacement(self):
        self.path.symlink_to(self.world / 'missing')
        with self.assertRaises(OSError):
            with sessions.WorldSession(self.world, create=True):
                self.fail('symlink identity entered')
        self.assertTrue(self.path.is_symlink())
        self.assertFalse((self.world / 'missing').exists())
        self.assert_released()

    def test_published_identity_survives_creation_failure(self):
        with mock.patch.object(identity, '_sync_directory',
                               side_effect=OSError('directory sync failed')):
            with self.assertRaisesRegex(OSError, 'directory sync failed'):
                with sessions.WorldSession(self.world, create=True):
                    self.fail('failed creation entered')
        self.assert_released()
        published = identity.sync_world_identity(self.world)
        with sessions.WorldSession(self.world, create=True) as restored:
            self.assertEqual(restored.world_id, published)
        self.assert_released()

    def test_cross_process_contention_and_normal_release(self):
        with sessions.WorldSession(self.world, create=True) as session:
            self.assertEqual(self.probe_process(), 'busy')
            world_id = session.world_id
        self.assertEqual(self.probe_process(), 'entered')
        self.assertEqual(identity.read_world_identity(self.world), world_id)

    def test_contention_happens_before_reading_or_creating(self):
        with locks.WorldLock(self.world):
            with mock.patch.object(sessions, 'read_world_identity') as read, \
                    mock.patch.object(sessions, 'create_world_identity') as create:
                with self.assertRaises(BlockingIOError):
                    with sessions.WorldSession(self.world, create=True):
                        self.fail('contended world entered')
                read.assert_not_called()
                create.assert_not_called()
            self.assertEqual(self.probe_process(), 'busy')
        self.assertFalse(self.path.exists())
        self.assert_released()

    def test_body_base_exception_releases_and_propagates(self):
        session = sessions.WorldSession(self.world, create=True)
        with self.assertRaisesRegex(KeyboardInterrupt, 'body failure'):
            with session:
                raise KeyboardInterrupt('body failure')
        self.assertIsNone(session.world_id)
        self.assertEqual(self.probe_process(), 'entered')

    def test_entry_errors_release_and_allow_retry(self):
        session = sessions.WorldSession(self.world, create=True)
        for operation in ('read_world_identity', 'create_world_identity'):
            with self.subTest(operation=operation):
                with mock.patch.object(sessions, operation,
                                       side_effect=OSError('injected failure')):
                    with self.assertRaisesRegex(OSError, 'injected failure'):
                        with session:
                            self.fail('failed entry reached body')
                self.assertIsNone(session.world_id)
                self.assert_released()
        with session:
            self.assertIsNotNone(session.world_id)
        self.assert_released()

    def test_reentrant_entry_does_not_release_outer_session(self):
        session = sessions.WorldSession(self.world, create=True)
        with session:
            world_id = session.world_id
            with self.assertRaises(RuntimeError):
                with session:
                    self.fail('nested session entered')
            self.assertEqual(session.world_id, world_id)
            self.assertEqual(self.probe_process(), 'busy')
        with session:
            self.assertEqual(session.world_id, world_id)
        self.assert_released()


if __name__ == '__main__':
    unittest.main()
