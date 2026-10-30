import contextlib
from copy import deepcopy
import io
import json
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from threading import Barrier, Event, Lock
import unittest
from unittest import mock

from model import adapter
from model.product_envelope import MAX_ENVELOPE_BYTES
from validation import model_load


CONFIG = adapter.Config('https://private-provider.invalid/v1', 'test-model', 'secret-api-key')


def context(actor='alice'):
    observation = {'nearby_agents': [], 'has_target': False}
    return {
        'observation': observation,
        'bounds': {'min': {'x': -1, 'y': 0, 'z': -1}, 'max': {'x': 1, 'y': 1, 'z': 1}},
        'reflection_input': {'private_reflection': 'must not be sent'},
        'model_input': {
            'schema': 'wispiva.model-input', 'version': 1,
            'request': {'decision_id': f'original-{actor}', 'world_id': 'world-1',
                        'actor_id': actor, 'origin_event_id': 'event-1',
                        'world_revision': 1, 'observed_at': 100},
            'actor': {
                'id': actor, 'runtime_id': 1 if actor == 'alice' else 2, 'name': actor.title(),
                'role': {'text': f'{actor}-role', 'source': {'kind': 'genesis.role', 'id': 'role-1'}},
                'goal': {'text': f'{actor}-goal', 'source': {'kind': 'genesis.goal', 'id': 'goal-1'}},
                'permissions': {'read_scopes': ['private'], 'allowed_actions': ['inspect']},
            },
            'knowledge': {'facts': [], 'experiences': [], 'rumors': [], 'unknowns': [{
                'id': f'{actor}-seed', 'text': f'{actor}-private', 'epistemic': 'unknown',
                'source': {'kind': 'genesis_seed', 'id': 'event-1'},
                'access': {'scope': 'private', 'audience': [actor]},
            }]},
            'current': {'observation': observation, 'inventory': {}, 'affordances': {}},
            'feedback': {'available': False},
        },
    }


def success(index=0):
    action = {'kind': 'inspect', 'why': 'model'}
    return {'action': action, 'output_text': json.dumps(action),
            'audit': {'context_sha256': 'a' * 64, 'prompt_sha256': 'b' * 64,
                      'latency_ms': 2, 'usage': {
                          'input_tokens': index + 1, 'output_tokens': 2, 'total_tokens': index + 3}}}


class Clock:
    def __init__(self):
        self.value = 0.0
        self.lock = Lock()

    def __call__(self):
        with self.lock:
            return self.value

    def advance(self, seconds):
        with self.lock:
            self.value += seconds


class ModelLoadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.audit = self.root / 'audit'
        self.audit.mkdir()
        self.output = self.root / 'output'
        self.write('request-1-agent-1.json', context())
        # Any accidental path into the real transport is a test failure.
        transport = mock.patch.object(adapter, '_transport', side_effect=AssertionError('real transport forbidden'))
        self.transport = transport.start()
        self.addCleanup(transport.stop)

    def write(self, name, value):
        path = self.audit / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({'id': 1, 'context': value}), encoding='utf-8')
        return path

    def rows(self):
        return [json.loads(line) for line in (self.output / 'calls.jsonl').read_text().splitlines()]

    def test_bounded_parallel_replay_preserves_each_private_envelope(self):
        self.write('nested/request-2-agent-2.json', context('bob'))
        originals = {path: path.read_bytes() for path in self.audit.rglob('*.json')}
        barrier = Barrier(3, timeout=5)
        seen = []
        lock = Lock()

        def runner(config, value):
            self.assertIs(config, CONFIG)
            self.assertNotIn('reflection_input', value)
            envelope = value['model_input']
            actor = envelope['actor']['id']
            expected = context(actor)['model_input']
            expected['request']['decision_id'] = envelope['request']['decision_id']
            self.assertEqual(envelope, expected)
            with lock:
                seen.append(deepcopy(value))
            # Each batch of three calls must overlap; no real sleeps or provider.
            barrier.wait()
            envelope['knowledge']['unknowns'][0]['text'] = 'runner mutation'
            return success()

        summary = model_load.run(self.audit, self.output, calls=6, concurrency=3,
                                 config=CONFIG, runner=runner)
        self.assertEqual(summary['active_max'], 3)
        self.assertEqual(summary['successful_calls'], 6)
        self.assertEqual(summary['runner'], 'injected')
        self.assertEqual(summary['mode'], 'audit_replay')
        self.assertTrue(summary['action_generation_only'])
        self.assertEqual(summary['live_actor_count'], 0)
        self.assertEqual(summary['replayed_actor_count'], 2)
        self.assertEqual(summary['source_samples'], 2)
        self.assertEqual(len({value['model_input']['request']['decision_id'] for value in seen}), 6)
        rows = sorted(self.rows(), key=lambda row: row['sample'])
        self.assertEqual([row['actor_id'] for row in rows], ['alice', 'bob'] * 3)
        for row in rows:
            self.assertEqual(row['world_id'], 'world-1')
            self.assertEqual(row['source_decision_id'], f"original-{row['actor_id']}")
            self.assertEqual(row['result'], success())
            self.assertEqual(row['audit'], row['result']['audit'])
            self.assertGreaterEqual(row['queue_wait_ms'], 0)
            self.assertGreaterEqual(row['latency_ms'], 0)
        self.assertEqual({path: path.read_bytes() for path in originals}, originals)
        self.assertEqual(json.loads((self.output / 'summary.json').read_text()), summary)
        for path in (self.output, self.output / 'calls.jsonl', self.output / 'summary.json'):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode) & 0o077, 0)
        self.transport.assert_not_called()

    def test_timing_percentiles_throughput_and_token_totals(self):
        clock = Clock()

        def runner(_config, value):
            index = int(value['model_input']['request']['decision_id'].rsplit(':', 1)[1])
            clock.advance((index + 1) / 10)
            return success(index)

        summary = model_load.run(self.audit, self.output, calls=4, concurrency=1,
                                 config=CONFIG, runner=runner, clock=clock)
        self.assertAlmostEqual(summary['elapsed_s'], 1)
        self.assertAlmostEqual(summary['throughput_calls_per_s'], 4)
        self.assertAlmostEqual(summary['successful_actions_per_s'], 4)
        self.assertAlmostEqual(summary['latency_ms']['p50'], 200)
        self.assertAlmostEqual(summary['latency_ms']['p95'], 400)
        self.assertEqual(summary['active_max'], 1)
        self.assertEqual(summary['token_totals'], {'input_tokens': 10, 'output_tokens': 8, 'total_tokens': 18})
        self.assertEqual(summary['token_reported_calls'], dict.fromkeys(model_load.TOKEN_FIELDS, 4))
        self.assertTrue(summary['token_totals_complete'])
        self.assertEqual(summary['errors'], {})
        self.assertEqual(model_load._percentiles([40, 10, 30, 20]), {'samples': 4, 'p50': 20, 'p95': 40})

    def test_errors_usage_and_credentials_are_safe_without_retries(self):
        audit = {'latency_ms': 2, 'usage': {'input_tokens': 3, 'output_tokens': 4, 'total_tokens': 7},
                 'endpoint': CONFIG.base_url, 'api_key': CONFIG.api_key}
        failures = {
            1: adapter.ModelError('rate_limited', audit),
            2: TimeoutError(f'{CONFIG.base_url} {CONFIG.api_key}'),
            3: RuntimeError(f'{CONFIG.base_url} {CONFIG.api_key}'),
            4: adapter.ModelError(f'{CONFIG.base_url} {CONFIG.api_key}', audit),
            5: adapter.ModelError('timeout'),
            6: adapter.ModelError('invalid_action', {'usage': {'input_tokens': True, 'output_tokens': 4}}),
        }
        seen = []

        def runner(_config, value):
            index = int(value['model_input']['request']['decision_id'].rsplit(':', 1)[1])
            seen.append(index)
            if index in failures:
                raise failures[index]
            result = success()
            result['action']['text'] = f'{CONFIG.base_url}/responses {CONFIG.api_key}'
            result['output_text'] = json.dumps(result['action'])
            result['audit'].update(endpoint=CONFIG.base_url, key=CONFIG.api_key)
            return result

        summary = model_load.run(self.audit, self.output, calls=7, concurrency=1,
                                 config=CONFIG, runner=runner)
        self.assertEqual(seen, list(range(7)))
        self.assertEqual(summary['successful_calls'], 1)
        self.assertEqual(summary['failed_calls'], 6)
        self.assertEqual(summary['errors'], {'rate_limited': 1, 'timeout': 2, 'internal_error': 2, 'invalid_action': 1})
        self.assertFalse(summary['token_totals_complete'])
        self.assertEqual(summary['invalid_usage_calls'], 1)
        self.assertEqual(summary['token_totals'], {'input_tokens': 7, 'output_tokens': 14, 'total_tokens': 17})
        for name in ('calls.jsonl', 'summary.json'):
            text = (self.output / name).read_text()
            self.assertNotIn(CONFIG.api_key, text)
            self.assertNotIn(CONFIG.base_url, text)
            self.assertNotIn('private-provider.invalid', text)
        self.assertNotIn('endpoint', self.rows()[1]['audit'])
        self.transport.assert_not_called()

    def test_queue_wait_excludes_time_spent_generating_the_action(self):
        clock = Clock()
        submitted = Event()
        executor_class = model_load.ThreadPoolExecutor

        class Executor(executor_class):
            def submit(self, *args, **kwargs):
                future = super().submit(*args, **kwargs)
                if args[1] == 1:
                    submitted.set()
                return future

        def runner(_config, _value):
            self.assertTrue(submitted.wait(timeout=5))
            clock.advance(.5)
            return success()

        with mock.patch.object(model_load, 'ThreadPoolExecutor', Executor):
            summary = model_load.run(self.audit, self.output, calls=2, concurrency=1,
                                     config=CONFIG, runner=runner, clock=clock)
        rows = sorted(self.rows(), key=lambda row: row['sample'])
        self.assertEqual([row['queue_wait_ms'] for row in rows], [0, 500])
        self.assertEqual([row['latency_ms'] for row in rows], [500, 500])
        self.assertEqual(summary['queue_wait_ms'], {'samples': 2, 'p50': 0, 'p95': 500})

    def test_all_selected_inputs_validate_before_any_runner_call(self):
        invalid = context('bob')
        invalid['model_input']['knowledge']['unknowns'][0]['access']['audience'] = ['alice']
        self.write('request-2-agent-2.json', invalid)
        runner = mock.Mock()
        with self.assertRaisesRegex(ValueError, '^invalid_audit$'):
            model_load.run(self.audit, self.output, calls=4, config=CONFIG, runner=runner)
        runner.assert_not_called()
        self.assertFalse(self.output.exists())

    def test_malformed_missing_legacy_duplicate_and_oversized_audits_fail_closed(self):
        path = self.audit / 'request-1-agent-1.json'
        cases = ('{broken', json.dumps({'id': 1, 'context': {}}),
                 json.dumps({'id': 1, 'context': {'model_input': None}}),
                 json.dumps({'id': True, 'context': context()}),
                 json.dumps({'id': 1, 'context': context()}).replace('"version": 1', '"version": 1, "version": 2'),
                 ' ' * (model_load.MAX_AUDIT_BYTES + 1))
        for text in cases:
            with self.subTest(length=len(text)):
                path.write_text(text)
                runner = mock.Mock()
                with self.assertRaisesRegex(ValueError, '^invalid_audit$'):
                    model_load.run(self.audit, self.output, calls=1, config=CONFIG, runner=runner)
                runner.assert_not_called()
                self.assertFalse(self.output.exists())

    def test_unique_decision_id_size_is_preflighted_before_any_call(self):
        value = context('bob')
        envelope = value['model_input']
        envelope['current']['observation']['padding'] = ''
        size = len(json.dumps(envelope, ensure_ascii=True, sort_keys=True, separators=(',', ':')).encode())
        envelope['current']['observation']['padding'] = 'x' * (MAX_ENVELOPE_BYTES - size)
        model_load.validate_envelope(envelope)
        self.write('request-2-agent-2.json', value)
        runner = mock.Mock()
        with self.assertRaises(ValueError):
            model_load.run(self.audit, self.output, calls=4, config=CONFIG, runner=runner)
        runner.assert_not_called()
        self.assertFalse(self.output.exists())

    def test_symlink_audit_is_rejected_and_response_files_are_ignored(self):
        path = self.audit / 'request-1-agent-1.json'
        path.rename(self.audit / 'response-1-agent-1.json')
        with self.assertRaisesRegex(ValueError, '^invalid_audit$'):
            model_load.load_inputs(self.audit)
        path.symlink_to(self.audit / 'response-1-agent-1.json')
        with self.assertRaisesRegex(ValueError, '^invalid_audit$'):
            model_load.load_inputs(self.audit)

    def test_explicit_bounds_and_existing_output_prevent_calls(self):
        runner = mock.Mock()
        for calls, concurrency in ((0, 1), (2049, 1), (True, 1), (1, 0), (1, 17), (1, True)):
            with self.subTest(calls=calls, concurrency=concurrency):
                with self.assertRaisesRegex(ValueError, '^invalid_load_configuration$'):
                    model_load.run(self.audit, self.output, calls=calls, concurrency=concurrency,
                                   config=CONFIG, runner=runner)
        self.output.mkdir()
        (self.output / 'sentinel').write_text('preserve')
        with self.assertRaises(FileExistsError):
            model_load.run(self.audit, self.output, calls=1, config=CONFIG, runner=runner)
        self.assertEqual((self.output / 'sentinel').read_text(), 'preserve')
        runner.assert_not_called()

    def test_missing_usage_is_unknown_and_runs_have_distinct_decision_ids(self):
        seen = []

        def runner(_config, value):
            seen.append(value['model_input']['request']['decision_id'])
            return {'action': {'kind': 'inspect'}, 'audit': {}}

        with mock.patch.object(adapter.Config, 'from_env', return_value=CONFIG) as from_env:
            first = model_load.run(self.audit, self.output, calls=1, runner=runner)
        from_env.assert_called_once_with()
        model_load.run(self.audit, self.root / 'second-output', calls=1, config=CONFIG, runner=runner)
        self.assertEqual(first['token_totals'], dict.fromkeys(model_load.TOKEN_FIELDS))
        self.assertFalse(first['token_totals_complete'])
        self.assertEqual(len(set(seen)), 2)

    def test_default_runner_uses_adapter_decide_without_network(self):
        with mock.patch.object(adapter, 'decide', return_value=success()) as decision:
            summary = model_load.run(self.audit, self.output, calls=1, config=CONFIG)
        decision.assert_called_once()
        self.assertIs(decision.call_args.args[0], CONFIG)
        self.assertNotIn('reflection_input', decision.call_args.args[1])
        self.assertEqual(summary['runner'], 'provider')
        self.transport.assert_not_called()

    def test_cli_defaults_and_error_exit_codes(self):
        args = ['--audit-dir', str(self.audit), '--output', str(self.output)]
        with mock.patch.object(model_load, 'run', return_value={'failed_calls': 0}) as run:
            self.assertEqual(model_load.main(args), 0)
        run.assert_called_once_with(str(self.audit), str(self.output), calls=128, concurrency=4)
        with mock.patch.object(model_load, 'run', return_value={'failed_calls': 1}):
            self.assertEqual(model_load.main(args + ['--calls', '2048', '--concurrency', '16']), 1)
        with mock.patch.object(model_load, 'run', side_effect=OSError(CONFIG.api_key)), contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(model_load.main(args), 2)
        self.assertNotIn(CONFIG.api_key, stderr.getvalue())

    def test_direct_script_help_needs_no_credentials(self):
        process = subprocess.run([sys.executable, str(Path(model_load.__file__).resolve()), '--help'],
                                 cwd=self.root, text=True, capture_output=True, timeout=5)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertIn('--audit-dir', process.stdout)
        self.assertIn('--concurrency', process.stdout)


if __name__ == '__main__':
    unittest.main()
