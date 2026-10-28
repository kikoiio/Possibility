import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

import spool_worker as worker


class SpoolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)

    def test_atomic_response_and_bad_requests(self):
        request = {'id': 3, 'context': {'observation': {}}}
        path = self.root / 'request-3.json'
        path.write_text(json.dumps(request))
        self.assertTrue(worker.process_one(self.root, path, 1, runner=lambda req, stop, timeout: {'id': req['id'], 'ok': True, 'action': {'kind': 'inspect'}}))
        self.assertEqual(json.loads((self.root / 'response-3.json').read_text())['action']['kind'], 'inspect')
        self.assertFalse(path.exists())
        self.assertFalse(list(self.root.glob('.processing-*')))
        path = self.root / 'request-4.json'
        path.write_text(json.dumps(request))
        worker.process_one(self.root, path, 1)
        self.assertEqual(json.loads((self.root / 'response-4.json').read_text())['error'], 'invalid_id')
        self.assertFalse(list(self.root.glob('.response-*.tmp')))

    def test_timeout_and_stop_cleanup(self):
        for stopped in (False, True):
            with self.subTest(stopped=stopped):
                stop = self.root / 'STOP'
                if stopped:
                    stop.touch()
                child = mock.Mock()
                child.poll.return_value = None
                def communicate(*args, **kwargs):
                    if 'timeout' in kwargs:
                        raise subprocess.TimeoutExpired('x', 0.1)
                    return (b'', b'')
                child.communicate.side_effect = communicate
                with mock.patch.object(worker.subprocess, 'Popen', return_value=child):
                    result = worker.run_bridge({'id': 1}, stop, 0.001)
                self.assertEqual(result['error'], 'stopped' if stopped else 'timeout')
                child.kill.assert_called_once()
                stop.unlink(missing_ok=True)

    def test_worker_process_without_credentials(self):
        env = {k: v for k, v in os.environ.items() if not (k.startswith('XUNFEI_') or k.startswith('WISPIVA_LLM_'))}
        env['PYTHONDONTWRITEBYTECODE'] = '1'
        process = subprocess.Popen([sys.executable, '-B', str(Path(worker.__file__)), str(self.root), '--poll-interval', '0.01'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            (self.root / 'request-1.json').write_text(json.dumps({'id': 1, 'context': {}}))
            end = time.monotonic() + 3
            response = self.root / 'response-1.json'
            while not response.exists() and time.monotonic() < end:
                time.sleep(0.01)
            self.assertTrue(response.exists())
            self.assertEqual(json.loads(response.read_text()), {'id': 1, 'ok': False, 'error': 'invalid_config'})
            (self.root / 'STOP').touch()
            self.assertEqual(process.wait(timeout=3), 0)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            process.stderr.close()


if __name__ == '__main__':
    unittest.main()
