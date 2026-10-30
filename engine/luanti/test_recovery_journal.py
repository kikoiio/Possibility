import os
from pathlib import Path
import tempfile
import unittest

from engine.luanti.recovery_journal import MARKER_FILE, RecoveryRequired, SessionJournal


class RecoveryJournalTests(unittest.TestCase):
    def test_normal_session_publishes_and_durably_clears_marker(self):
        with tempfile.TemporaryDirectory() as root:
            journal = SessionJournal(root, 'world-a')
            session_id = journal.begin()
            self.assertTrue(session_id)
            marker = Path(root) / MARKER_FILE
            self.assertTrue(marker.exists())
            journal.finish()
            self.assertFalse(marker.exists())

    def test_stale_marker_fails_closed_until_explicit_acknowledgement(self):
        with tempfile.TemporaryDirectory() as root:
            journal = SessionJournal(root, 'world-a')
            session_id = journal.begin()
            self.assertTrue(session_id)
            with self.assertRaises(RecoveryRequired):
                SessionJournal(root, 'world-a').begin()
            with self.assertRaises(RecoveryRequired):
                SessionJournal.acknowledge(root, 'world-b')
            self.assertEqual(SessionJournal.acknowledge(root, 'world-a'), session_id)
            self.assertFalse((Path(root) / MARKER_FILE).exists())

    def test_corrupt_or_cross_world_marker_is_never_cleared_implicitly(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / MARKER_FILE
            path.write_text('{"version": 1, "world_id": "world-a"}', encoding='utf-8')
            with self.assertRaises(RecoveryRequired):
                SessionJournal(root, 'world-a').begin()
            self.assertTrue(path.exists())

    def test_marker_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / MARKER_FILE
            path.symlink_to(Path(root) / 'target')
            with self.assertRaises(RecoveryRequired):
                SessionJournal(root, 'world-a').begin()
            self.assertTrue(path.is_symlink())

    def test_marker_survives_process_kill(self):
        with tempfile.TemporaryDirectory() as root:
            child = os.fork()
            if child == 0:
                try:
                    SessionJournal(root, 'world-a').begin()
                    os.kill(os.getpid(), 9)
                finally:
                    os._exit(1)
            _, status = os.waitpid(child, 0)
            self.assertTrue(os.WIFSIGNALED(status))
            with self.assertRaises(RecoveryRequired):
                SessionJournal(root, 'world-a').begin()


if __name__ == '__main__':
    unittest.main()
