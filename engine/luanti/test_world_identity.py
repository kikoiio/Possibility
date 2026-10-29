import errno
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest import mock
import uuid

from engine.luanti import world_identity as identity


class WorldIdentityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.world = self.root / 'world'
        self.world.mkdir()
        self.path = self.world / identity.IDENTITY_FILE

    def test_separate_worlds_and_clone(self):
        other = self.root / 'other'
        other.mkdir()
        first = identity.create_world_identity(self.world)
        second = identity.create_world_identity(other)
        self.assertEqual(str(uuid.UUID(first)), first)
        self.assertNotEqual(first, second)
        self.assertEqual(identity.read_world_identity(self.world), first)
        self.assertFalse((self.world / 'map.sqlite').exists())
        clone = self.root / 'clone'
        shutil.copytree(self.world, clone)
        self.assertEqual(identity.read_world_identity(clone), first)
        with self.assertRaises(FileExistsError):
            identity.create_world_identity(clone)

    def test_missing_and_corrupt_files_are_rejected(self):
        with self.assertRaises(FileNotFoundError):
            identity.read_world_identity(self.world)
        canonical = b'12345678-1234-4234-8234-123456789abc'
        for data in (b'', b'garbage', canonical, canonical.upper() + b'\n',
                     canonical + b'\nextra', canonical + b'\r\n', b'\xff\n',
                     b'{' + canonical + b'}\n'):
            with self.subTest(data=data):
                self.path.write_bytes(data)
                with self.assertRaises(ValueError):
                    identity.read_world_identity(self.world)
                with self.assertRaises(FileExistsError):
                    identity.create_world_identity(self.world)
                self.assertEqual(self.path.read_bytes(), data)

    def test_symlinks_and_non_regular_files_are_rejected(self):
        target = self.root / 'target'
        target.write_text('12345678-1234-4234-8234-123456789abc\n')
        for link_target in (target, self.root / 'missing'):
            with self.subTest(target=link_target):
                self.path.symlink_to(link_target)
                with self.assertRaises(OSError):
                    identity.read_world_identity(self.world)
                with self.assertRaises(FileExistsError):
                    identity.create_world_identity(self.world)
                self.assertTrue(self.path.is_symlink())
                self.path.unlink()
        os.mkfifo(self.path)
        with self.assertRaises(ValueError):
            identity.read_world_identity(self.world)

    def test_sync_precedes_publication_and_directory_sync_follows(self):
        events = []
        original_fsync = identity.os.fsync
        original_link = identity.os.link

        def fsync(fd):
            events.append('directory' if os.path.isdir(f'/proc/self/fd/{fd}') else 'file')
            return original_fsync(fd)

        def link(*args, **kwargs):
            events.append('publish')
            return original_link(*args, **kwargs)

        with mock.patch.object(identity.os, 'fsync', side_effect=fsync), \
                mock.patch.object(identity.os, 'link', side_effect=link):
            identity.create_world_identity(self.world)
        self.assertEqual(events, ['file', 'publish', 'directory'])

    def test_failure_before_publication_can_retry(self):
        with mock.patch.object(identity.os, 'fsync', side_effect=OSError(errno.EIO, 'sync')):
            with self.assertRaises(OSError):
                identity.create_world_identity(self.world)
        self.assertFalse(self.path.exists())
        self.assertEqual(list(self.world.iterdir()), [])
        created = identity.create_world_identity(self.world)
        self.assertEqual(identity.read_world_identity(self.world), created)
        with self.assertRaises(FileExistsError):
            identity.create_world_identity(self.world)
        self.assertEqual(identity.read_world_identity(self.world), created)

    def test_failure_after_publication_recovery(self):
        with mock.patch.object(identity, '_sync_directory', side_effect=OSError(errno.EIO, 'sync')):
            with self.assertRaises(OSError):
                identity.create_world_identity(self.world)
        published = identity.read_world_identity(self.world)
        with self.assertRaises(FileExistsError):
            identity.create_world_identity(self.world)
        self.assertEqual(identity.sync_world_identity(self.world), published)
        self.assertEqual(identity.read_world_identity(self.world), published)

    def test_cleanup_failure_keeps_primary_result_and_syncs_published_file(self):
        with mock.patch.object(identity.os, 'unlink', side_effect=OSError(errno.EIO, 'cleanup')), \
                mock.patch.object(identity, '_sync_directory', wraps=identity._sync_directory) as sync:
            with self.assertRaises(OSError) as caught:
                identity.create_world_identity(self.world)
        self.assertEqual(caught.exception.errno, errno.EIO)
        self.assertTrue(self.path.exists())
        self.assertEqual(identity.read_world_identity(self.world),
                         self.path.read_text().strip())
        sync.assert_called_once_with(self.world)

    def test_io_failures_propagate(self):
        with mock.patch.object(identity.os, 'link', side_effect=OSError(errno.EIO, 'link')):
            with self.assertRaises(OSError):
                identity.create_world_identity(self.world)
        self.assertEqual(list(self.world.iterdir()), [])
        identity.create_world_identity(self.world)
        with mock.patch.object(identity.os, 'open', side_effect=OSError(errno.EIO, 'open')):
            with self.assertRaises(OSError):
                identity.read_world_identity(self.world)
        with mock.patch.object(identity.os, 'fsync', side_effect=OSError(errno.EIO, 'sync')):
            with self.assertRaises(OSError):
                identity.sync_world_identity(self.world)


if __name__ == '__main__':
    unittest.main()
