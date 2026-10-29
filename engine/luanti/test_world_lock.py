"""Directed tests of the controlled component, not real Luanti integration."""

import errno
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from engine.luanti import world_lock as locks


@unittest.skipUnless(locks.fcntl is not None and hasattr(os, 'O_NOFOLLOW'),
                     'requires Unix flock and O_NOFOLLOW')
class WorldLockTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.world = Path(self.tmp.name)
        self.path = self.world / locks.LOCK_FILE
        self.lock = locks.WorldLock(self.world)
        self.addCleanup(self.lock.release)

    def probe_process(self):
        result = subprocess.run(
            [sys.executable, '-B', '-c',
             'import sys\nfrom engine.luanti.world_lock import WorldLock\n'
             'lock = WorldLock(sys.argv[1])\n'
             'try:\n    print(lock.acquire())\nfinally:\n    lock.release()\n',
             str(self.world)],
            cwd=Path(__file__).resolve().parents[2],
            capture_output=True, text=True, timeout=10, check=True)
        return result.stdout.strip() == 'True'

    def test_cross_process_contention_release_and_reacquire(self):
        self.assertTrue(self.lock.acquire())
        inode = self.path.stat().st_ino
        self.assertFalse(self.probe_process())
        with self.assertRaises(RuntimeError):
            self.lock.acquire()
        self.assertFalse(self.probe_process())
        self.lock.release()
        self.lock.release()
        self.assertEqual(self.path.stat().st_ino, inode)
        self.assertTrue(self.probe_process())
        self.assertTrue(self.lock.acquire())

    def test_separate_instances_and_worlds(self):
        self.assertTrue(self.lock.acquire())
        contender = locks.WorldLock(self.world)
        self.addCleanup(contender.release)
        for _ in range(3):
            self.assertFalse(contender.acquire())
        with self.assertRaises(BlockingIOError):
            with contender:
                self.fail('contended context was entered')
        other = self.world / 'other'
        other.mkdir()
        with locks.WorldLock(other):
            self.assertFalse(contender.acquire())
        self.lock.release()
        self.assertTrue(contender.acquire())

    def test_context_releases_after_normal_exit_and_exception(self):
        with self.lock as held:
            self.assertIs(held, self.lock)
            self.assertFalse(self.probe_process())
        self.assertTrue(self.probe_process())
        with self.assertRaisesRegex(ValueError, 'body failure'):
            with self.lock:
                raise ValueError('body failure')
        self.assertTrue(self.probe_process())

    def test_abrupt_process_exit_releases_without_deleting_file(self):
        result = subprocess.run(
            [sys.executable, '-B', '-c',
             'import os, sys\nfrom engine.luanti.world_lock import WorldLock\n'
             'lock = WorldLock(sys.argv[1])\n'
             'assert lock.acquire()\nos._exit(23)\n', str(self.world)],
            cwd=Path(__file__).resolve().parents[2],
            capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 23, result.stderr)
        self.assertTrue(self.path.is_file())
        self.assertTrue(self.lock.acquire())

    def test_symlinks_and_non_regular_files_are_rejected(self):
        target = self.world / 'target'
        target.write_bytes(b'unchanged')
        for destination in (target, self.world / 'missing'):
            with self.subTest(destination=destination):
                self.path.symlink_to(destination)
                with self.assertRaises(OSError):
                    self.lock.acquire()
                self.assertTrue(self.path.is_symlink())
                self.path.unlink()
        self.assertEqual(target.read_bytes(), b'unchanged')
        self.assertFalse((self.world / 'missing').exists())
        os.mkfifo(self.path)
        with self.assertRaises(ValueError):
            self.lock.acquire()
        self.path.unlink()
        self.path.mkdir()
        with self.assertRaises(OSError):
            self.lock.acquire()
        self.path.rmdir()
        self.assertTrue(self.lock.acquire())

    def test_acquire_errors_close_descriptor_and_allow_retry(self):
        for operation in ('fstat', 'flock', 'stat'):
            module = locks.fcntl if operation == 'flock' else locks.os
            with self.subTest(operation=operation):
                with mock.patch.object(module, operation,
                                       side_effect=OSError(errno.EIO, 'injected')), \
                        mock.patch.object(locks.os, 'close', wraps=os.close) as close:
                    with self.assertRaises(OSError) as caught:
                        self.lock.acquire()
                    self.assertEqual(caught.exception.errno, errno.EIO)
                    close.assert_called_once()
                    closed_fd = close.call_args.args[0]
                with self.assertRaises(OSError) as closed:
                    os.fstat(closed_fd)
                self.assertEqual(closed.exception.errno, errno.EBADF)
                self.assertTrue(self.probe_process())
                self.assertTrue(self.lock.acquire())
                self.lock.release()

    def test_contention_closes_descriptor_and_allows_retry(self):
        for code in (errno.EACCES, errno.EAGAIN):
            with self.subTest(errno=code):
                with mock.patch.object(locks.fcntl, 'flock',
                                       side_effect=OSError(code, 'busy')), \
                        mock.patch.object(locks.os, 'close', wraps=os.close) as close:
                    self.assertFalse(self.lock.acquire())
                    close.assert_called_once()
                with self.assertRaises(OSError) as closed:
                    os.fstat(close.call_args.args[0])
                self.assertEqual(closed.exception.errno, errno.EBADF)
                self.assertTrue(self.lock.acquire())
                self.lock.release()

    def test_existing_lock_file_is_reused_without_truncation(self):
        self.path.write_bytes(b'existing content is not ownership evidence')
        inode = self.path.stat().st_ino
        with self.lock:
            self.assertEqual(self.path.stat().st_ino, inode)
        self.assertEqual(self.path.read_bytes(),
                         b'existing content is not ownership evidence')

    def test_unlock_error_still_closes_and_allows_retry(self):
        self.assertTrue(self.lock.acquire())
        with mock.patch.object(locks.fcntl, 'flock',
                               side_effect=OSError(errno.EIO, 'unlock')):
            with self.assertRaises(OSError):
                self.lock.release()
        self.lock.release()
        self.assertTrue(self.probe_process())
        self.assertTrue(self.lock.acquire())

    def test_open_error_allows_retry(self):
        with mock.patch.object(locks.os, 'open',
                               side_effect=PermissionError(errno.EACCES, 'open')):
            with self.assertRaises(PermissionError):
                self.lock.acquire()
        self.assertTrue(self.lock.acquire())

    def test_replaced_path_during_acquisition_is_rejected(self):
        flock = locks.fcntl.flock

        def replace(fd, flags):
            flock(fd, flags)
            self.path.unlink()
            self.path.write_bytes(b'replacement')

        with mock.patch.object(locks.fcntl, 'flock', side_effect=replace):
            with self.assertRaises(OSError) as caught:
                self.lock.acquire()
        self.assertEqual(caught.exception.errno, errno.ESTALE)
        self.assertTrue(self.lock.acquire())

    def test_descriptor_is_not_inherited_across_exec(self):
        self.assertTrue(self.lock.acquire())
        self.assertFalse(os.get_inheritable(self.lock._fd))

    def test_unsupported_platform_fails_without_creating_file(self):
        with mock.patch.object(locks, 'fcntl', None):
            with self.assertRaises(NotImplementedError):
                self.lock.acquire()
        self.assertFalse(self.path.exists())


if __name__ == '__main__':
    unittest.main()
