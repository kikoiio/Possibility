import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

from model import spool_worker as worker


class SpoolTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.root = Path(self.temp.name)
        self.addCleanup(self.temp.cleanup)

    def test_invalid_action_retries_are_bounded_and_audited(self):
        path = self.root / 'request-1.json'
        path.write_text(json.dumps({'id': 1, 'context': {}}))
        runner = mock.Mock(side_effect=[{'id': 1, 'ok': False, 'error': 'invalid_action'},
                                       {'id': 1, 'ok': True, 'action': {'kind': 'inspect'}}])
        worker.process_one(self.root, path, 1, runner=runner)
        result = json.loads((self.root / 'response-1.json').read_text())
        self.assertEqual([a['ok'] for a in result['attempts']], [False, True])
        self.assertEqual(runner.call_count, 2)

    def test_transport_retries_are_bounded_and_audited(self):
        path = self.root / 'request-2.json'
        path.write_text(json.dumps({'id': 2, 'context': {}}))
        runner = mock.Mock(side_effect=[{'id': 2, 'ok': False, 'error': 'transport_error',
                                         'audit': {'latency_ms': 30000}},
                                       {'id': 2, 'ok': True, 'action': {'kind': 'inspect'}}])
        worker.process_one(self.root, path, 1, runner=runner)
        result = json.loads((self.root / 'response-2.json').read_text())
        self.assertEqual([a['error'] for a in result['attempts']], ['transport_error', None])
        self.assertEqual(runner.call_count, 2)

    def test_invalid_response_and_rate_limit_retries_are_bounded_and_audited(self):
        path = self.root / 'request-5.json'
        path.write_text(json.dumps({'id': 5, 'context': {}}))
        runner = mock.Mock(side_effect=[
            {'id': 5, 'ok': False, 'error': 'invalid_response'},
            {'id': 5, 'ok': False, 'error': 'rate_limited'},
            {'id': 5, 'ok': True, 'action': {'kind': 'inspect'}},
        ])
        with mock.patch.object(worker.time, 'sleep') as sleep:
            worker.process_one(self.root, path, 1, runner=runner)
        result = json.loads((self.root / 'response-5.json').read_text())
        self.assertEqual([a['error'] for a in result['attempts']],
                         ['invalid_response', 'rate_limited', None])
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [1, 2])
        self.assertEqual(runner.call_count, 3)

    def test_provider_failure_retries_are_bounded_and_audited(self):
        path = self.root / 'request-6.json'
        path.write_text(json.dumps({'id': 6, 'context': {}}))
        runner = mock.Mock(side_effect=[
            {'id': 6, 'ok': False, 'error': 'provider_failed'},
            {'id': 6, 'ok': True, 'action': {'kind': 'inspect'}},
        ])
        with mock.patch.object(worker.time, 'sleep') as sleep:
            worker.process_one(self.root, path, 1, runner=runner)
        result = json.loads((self.root / 'response-6.json').read_text())
        self.assertEqual([attempt['error'] for attempt in result['attempts']],
                         ['provider_failed', None])
        self.assertEqual(runner.call_count, 2)
        sleep.assert_called_once_with(1)

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
            result = json.loads(response.read_text())
            self.assertEqual((result['id'], result['ok'], result['error']), (1, False, 'invalid_config'))
            self.assertEqual(len(result['attempts']), 1)
            (self.root / 'STOP').touch()
            self.assertEqual(process.wait(timeout=3), 0)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            process.stderr.close()

    def test_parallel_workers_are_bounded_and_complete_each_request_once(self):
        for request_id in range(1, 9):
            (self.root / f'request-{request_id}.json').write_text(
                json.dumps({'id': request_id, 'context': {}}))
        lock = threading.Lock()
        active = 0
        peak = 0
        completed = []

        def runner(request, stop, timeout):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
            time.sleep(0.04)
            with lock:
                active -= 1
                completed.append(request['id'])
            return {'id': request['id'], 'ok': True, 'action': {'kind': 'inspect'}}

        thread = threading.Thread(target=worker.serve,
                                  args=(self.root, 1, 0.01, runner),
                                  kwargs={'workers': 3})
        thread.start()
        deadline = time.monotonic() + 3
        while len(completed) < 8 and time.monotonic() < deadline:
            time.sleep(0.01)
        (self.root / 'STOP').touch()
        thread.join(timeout=3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(peak, 3)
        self.assertEqual(sorted(completed), list(range(1, 9)))
        for request_id in range(1, 9):
            result = json.loads((self.root / f'response-{request_id}.json').read_text())
            self.assertEqual((result['id'], result['ok']), (request_id, True))

    def test_worker_count_is_bounded(self):
        for workers in (0, worker.MAX_WORKERS + 1, True):
            with self.subTest(workers=workers), self.assertRaises(ValueError):
                worker.serve(self.root, workers=workers)


if __name__ == '__main__':
    unittest.main()
