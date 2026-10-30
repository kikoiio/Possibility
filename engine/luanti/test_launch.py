import subprocess
import copy
import json
import sys
import tempfile
import time
import unittest
from unittest import mock
from pathlib import Path

from engine.luanti.world_session import WorldSession
from engine.luanti.launch import _verify_product_checkpoint, recover_committed_checkpoint
from engine.luanti.recovery_journal import MARKER_FILE, RecoveryRequired, SessionJournal


SCRIPT = Path(__file__).with_name('launch.py')


class LauncherTests(unittest.TestCase):
    def test_identity_and_lock_cover_child_lifetime(self):
        with tempfile.TemporaryDirectory() as tmp:
            world = Path(tmp) / 'world'
            world.mkdir()
            child = subprocess.Popen([
                sys.executable, '-B', str(SCRIPT), '--world', str(world),
                '--create-if-missing', '--', sys.executable, '-c',
                'import time; time.sleep(1.5)',
            ], cwd=Path(__file__).resolve().parents[2])
            try:
                deadline = time.monotonic() + 5
                while not (world / 'wispiva-world-id').exists():
                    self.assertLess(time.monotonic(), deadline)
                    time.sleep(0.02)
                with self.assertRaises(BlockingIOError):
                    with WorldSession(world):
                        self.fail('launcher child did not hold the world lock')
                self.assertEqual(child.wait(timeout=5), 0)
                with WorldSession(world) as session:
                    self.assertTrue(session.world_id)
            finally:
                if child.poll() is None:
                    child.terminate()
                    child.wait(timeout=5)

    def test_child_exit_code_is_preserved(self):
        with tempfile.TemporaryDirectory() as tmp:
            world = Path(tmp) / 'world'
            world.mkdir()
            result = subprocess.run([
                sys.executable, '-B', str(SCRIPT), '--world', str(world),
                '--create-if-missing', '--', sys.executable, '-c',
                'raise SystemExit(7)',
            ], cwd=Path(__file__).resolve().parents[2])
            self.assertEqual(result.returncode, 7)
            self.assertTrue((world / MARKER_FILE).is_file())
            retry = subprocess.run([
                sys.executable, '-B', str(SCRIPT), '--world', str(world), '--',
                sys.executable, '-c', 'raise SystemExit(0)',
            ], capture_output=True)
            self.assertNotEqual(retry.returncode, 0)
            self.assertIn(b'requires recovery', retry.stderr)
            with WorldSession(world):
                pass

    def test_product_cleanup_requires_complete_persisted_checkpoint(self):
        with tempfile.TemporaryDirectory() as tmp:
            world = Path(tmp)
            (world / 'mod_storage').mkdir()
            (world / 'map.sqlite').write_bytes(b'fixture-map')
            state = {'world_id': 'w', 'phase': 'READY', 'clock': {'logical_time': 7},
                     'components': {'memory': 1, 'events': 1}}
            fields = {'product_state': json.dumps(state),
                      'agent_state': json.dumps({'long_term': {'records': [{}]},
                                                 'world_events': {'events': [{}]}}),
                      'environment_state': json.dumps({'time': 7}), 'product_active_run': ''}
            path = world / 'mod_storage/society'
            path.write_text(json.dumps(fields))
            _verify_product_checkpoint(world, 'w')
            for key, value in [('phase', 'PREPARING'), ('world_id', 'other'),
                               ('clock', {'logical_time': 8}), ('pending', {'id': 'p'}),
                               ('components', {'memory': 2, 'events': 1})]:
                bad = copy.deepcopy(state)
                bad[key] = value
                path.write_text(json.dumps({**fields, 'product_state': json.dumps(bad)}))
                with self.assertRaises(RecoveryRequired):
                    _verify_product_checkpoint(world, 'w')
            path.write_text(json.dumps({**fields, 'product_active_run': 'unfinished'}))
            with self.assertRaises(RecoveryRequired):
                _verify_product_checkpoint(world, 'w')

    def test_recovery_clears_marker_only_for_verified_committed_checkpoint(self):
        with tempfile.TemporaryDirectory() as tmp:
            world = Path(tmp)
            (world / 'mod_storage').mkdir()
            (world / 'map.sqlite').write_bytes(b'fixture-map')
            with WorldSession(world, create=True) as session:
                world_id = session.world_id
                state = {'world_id': world_id, 'phase': 'READY', 'clock': {'logical_time': 7},
                         'components': {'memory': 1, 'events': 1}}
                fields = {'product_state': json.dumps(state),
                          'agent_state': json.dumps({'long_term': {'records': [{}]},
                                                     'world_events': {'events': [{}]}}),
                          'environment_state': json.dumps({'time': 7}), 'product_active_run': ''}
                (world / 'mod_storage/society').write_text(json.dumps(fields))
                SessionJournal(session.world_dir, session.world_id).begin()
            with mock.patch('engine.luanti.launch.validate_world_contract'):
                session_id = recover_committed_checkpoint(world, expected_world_id=world_id)
            self.assertTrue(session_id)
            self.assertFalse((world / MARKER_FILE).exists())
            with mock.patch('engine.luanti.launch.validate_world_contract'):
                self.assertIsNone(recover_committed_checkpoint(world, expected_world_id=world_id))

    def test_recovery_keeps_marker_when_checkpoint_is_active_or_incomplete(self):
        with tempfile.TemporaryDirectory() as tmp:
            world = Path(tmp)
            (world / 'mod_storage').mkdir()
            (world / 'map.sqlite').write_bytes(b'fixture-map')
            with WorldSession(world, create=True) as session:
                world_id = session.world_id
                state = {'world_id': world_id, 'phase': 'READY', 'clock': {'logical_time': 7},
                         'components': {'memory': 1, 'events': 1}}
                fields = {'product_state': json.dumps(state),
                          'agent_state': json.dumps({'long_term': {'records': [{}]},
                                                     'world_events': {'events': [{}]}}),
                          'environment_state': json.dumps({'time': 7}), 'product_active_run': 'unfinished'}
                (world / 'mod_storage/society').write_text(json.dumps(fields))
                SessionJournal(session.world_dir, session.world_id).begin()
            with mock.patch('engine.luanti.launch.validate_world_contract'):
                with self.assertRaises(RecoveryRequired):
                    recover_committed_checkpoint(world, expected_world_id=world_id)
            self.assertTrue((world / MARKER_FILE).is_file())


if __name__ == '__main__':
    unittest.main()
