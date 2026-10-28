import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name('snapshot.py')


class SnapshotTests(unittest.TestCase):
    def test_copy_is_independent_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, dest = root / 'source', root / 'dest'
            source.mkdir()
            (source / 'map.sqlite').write_bytes(b'world')
            def run():
                return subprocess.run([sys.executable, str(SCRIPT), str(source), str(dest)],
                                      capture_output=True, text=True)
            self.assertEqual(run().returncode, 0)
            (dest / 'map.sqlite').write_bytes(b'changed')
            self.assertEqual((source / 'map.sqlite').read_bytes(), b'world')
            self.assertNotEqual(run().returncode, 0)
            self.assertEqual((dest / 'map.sqlite').read_bytes(), b'changed')


if __name__ == '__main__':
    unittest.main()
