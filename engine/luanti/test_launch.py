import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from engine.luanti.world_session import WorldSession


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
            with WorldSession(world):
                pass


if __name__ == '__main__':
    unittest.main()
