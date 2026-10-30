import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from model import adapter, bridge, reflection, spool_worker


class BridgeEnvelopeTests(unittest.TestCase):
    def envelope(self):
        return {
            'schema': 'wispiva.model-input', 'version': 1,
            'request': {'decision_id': 'decision-1', 'world_id': 'world-1',
                        'actor_id': 'alice', 'origin_event_id': 'event-1',
                        'world_revision': 1, 'observed_at': 100.0},
            'actor': {
                'id': 'alice', 'runtime_id': 1, 'name': 'Alice',
                'role': {'text': 'scout', 'source': {'kind': 'genesis.role', 'id': 'role-1'}},
                'goal': {'text': 'learn', 'source': {'kind': 'genesis.goal', 'id': 'goal-1'}},
                'permissions': {'read_scopes': ['public', 'private'],
                                'allowed_actions': ['inspect']},
            },
            'knowledge': {'facts': [], 'experiences': [], 'rumors': [], 'unknowns': []},
            'current': {'observation': {}, 'inventory': {}, 'affordances': {}},
            'feedback': {'available': False},
        }

    def test_product_envelope_is_validated_before_decision(self):
        calls = []
        def decision(_config, context):
            calls.append(context)
            return {'action': {'kind': 'inspect'}}
        source = io.StringIO(json.dumps({'id': 1, 'context': {'model_input': self.envelope()}}) + '\n')
        sink = io.StringIO()
        bridge.serve(source, sink, object(), decision=decision)
        self.assertEqual(len(calls), 1)
        self.assertTrue(json.loads(sink.getvalue())['ok'])

    def test_private_record_without_audience_is_rejected(self):
        value = self.envelope()
        value['knowledge']['unknowns'].append({
            'id': 'seed', 'text': 'private', 'epistemic': 'unknown',
            'source': {'kind': 'genesis_seed', 'id': 'origin'},
            'access': {'scope': 'private', 'audience': ['bob']},
        })
        calls = []
        source = io.StringIO(json.dumps({'id': 1, 'context': {'model_input': value}}) + '\n')
        sink = io.StringIO()
        bridge.serve(source, sink, object(), decision=lambda *_: calls.append(True))
        result = json.loads(sink.getvalue())
        self.assertFalse(result['ok'])
        self.assertEqual(result['error'], 'invalid_request')
        self.assertEqual(calls, [])

    def test_audience_container_and_source_are_strict(self):
        for audience, source in (('alice', {'kind': 'genesis_seed', 'id': 'origin'}),
                                 (['alice'], {'kind': '', 'id': 'origin'}),
                                 (['alice'], {'kind': 'genesis_seed', 'id': ''})):
            value = self.envelope()
            value['knowledge']['unknowns'].append({
                'id': 'seed', 'text': 'private', 'epistemic': 'unknown',
                'source': source, 'access': {'scope': 'private', 'audience': audience},
            })
            output = io.StringIO()
            bridge.serve(io.StringIO(json.dumps({'id': 1, 'context': {'model_input': value}}) + '\n'),
                         output, object(), decision=lambda *_: {'action': {'kind': 'inspect'}})
            self.assertEqual(json.loads(output.getvalue())['error'], 'invalid_request')


class BridgeReflectionTests(unittest.TestCase):
    envelope = BridgeEnvelopeTests.envelope

    def context(self):
        return {'model_input': self.envelope(),
                'reflection_input': reflection.build_input(
                    world_id='world-1', actor_id='alice', topic='the well',
                    experiences=[{'id': 'l1-1', 'text': 'I saw Bob near the well.',
                                  'source': {'kind': 'event', 'id': 'event-1'},
                                  'audience': ['alice'], 'captured_at': 3}])}

    def reply(self, context, *, decision=None, reflect=None):
        sink = io.StringIO()
        kwargs = {}
        if decision is not None:
            kwargs['decision'] = decision
        if reflect is not None:
            kwargs['reflection'] = reflect
        bridge.serve(io.StringIO(json.dumps({'id': 7, 'context': context}) + '\n'),
                     sink, object(), **kwargs)
        return json.loads(sink.getvalue())

    def assert_rejected_before_calls(self, context):
        decision, reflect = mock.Mock(), mock.Mock()
        self.assertEqual(self.reply(context, decision=decision, reflect=reflect),
                         {'id': 7, 'ok': False, 'error': 'invalid_request'})
        decision.assert_not_called()
        reflect.assert_not_called()

    def test_reflection_precedes_decision_and_has_separate_audit(self):
        context = self.context()
        calls = []
        proposal = {'topic': 'the well', 'text': 'Bob may help.', 'source_ids': ['l1-1']}
        reflection_audit = {'context_sha256': 'reflection-hash', 'usage': {'input_tokens': 4}}

        def reflect(_config, value):
            calls.append('reflect')
            self.assertEqual(build.call_count, 1)
            self.assertEqual(value, context['reflection_input'])
            return {'reflection': proposal, 'audit': reflection_audit}

        def decision(_config, value):
            calls.append('decide')
            self.assertEqual(value, {'model_input': context['model_input']})
            return {'action': {'kind': 'inspect'}, 'audit': {'context_sha256': 'decision-hash'}}

        with mock.patch.object(bridge, 'build_input', wraps=reflection.build_input) as build:
            result = self.reply(context, decision=decision, reflect=reflect)
        self.assertEqual(calls, ['reflect', 'decide'])
        self.assertTrue(result['ok'])
        self.assertEqual(result['reflection'], proposal)
        self.assertEqual(result['reflection_audit'], reflection_audit)
        self.assertEqual(result['audit'], {'context_sha256': 'decision-hash'})
        self.assertIn('reflection_input', context)

    def test_cross_actor_and_cross_world_are_rejected(self):
        for field, value in (('actor_id', 'bob'), ('world_id', 'world-2')):
            with self.subTest(field=field):
                context = self.context()
                context['reflection_input']['request'][field] = value
                # Make Bob's reflection internally valid; the envelope binding
                # itself must still reject it before either callable runs.
                if field == 'actor_id':
                    context['reflection_input']['experiences'][0]['audience'] = ['bob']
                self.assert_rejected_before_calls(context)

    def test_reflection_requires_a_valid_model_envelope(self):
        for mode in ('absent', 'null', 'actor_mismatch', 'private_audience'):
            with self.subTest(mode=mode):
                context = self.context()
                if mode == 'absent':
                    del context['model_input']
                elif mode == 'null':
                    context['model_input'] = None
                elif mode == 'actor_mismatch':
                    context['model_input']['request']['actor_id'] = 'bob'
                else:
                    context['model_input']['knowledge']['experiences'].append({
                        'id': 'private', 'text': 'secret', 'epistemic': 'experience',
                        'source': {'kind': 'event', 'id': 'event-2'},
                        'access': {'scope': 'private', 'audience': ['bob']}})
                self.assert_rejected_before_calls(context)

    def test_reflection_schema_is_exact(self):
        mutations = (
            lambda value: value.update(schema='other'),
            lambda value: value.pop('schema'),
            lambda value: value.update(version=2),
            lambda value: value.update(version=True),
            lambda value: value.update(version='1'),
            lambda value: value.update(extra='secret'),
            lambda value: value.update(request=None),
            lambda value: value['request'].pop('topic'),
            lambda value: value['request'].update(extra='secret'),
        )
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                context = self.context()
                mutate(context['reflection_input'])
                self.assert_rejected_before_calls(context)
        for value in (None, [], 'private'):
            with self.subTest(value=value):
                self.assert_rejected_before_calls({**self.context(), 'reflection_input': value})

    def test_build_input_validates_raw_experiences_before_calls(self):
        mutations = (
            lambda value: value.update(experiences=None),
            lambda value: value.update(experiences={}),
            lambda value: value.update(experiences=[]),
            lambda value: value.update(experiences=value['experiences'] * 17),
            lambda value: value['experiences'].append(value['experiences'][0]),
            lambda value: value['experiences'][0].update(audience=['bob']),
            lambda value: value['experiences'][0].update(audience='alice'),
            lambda value: value['experiences'][0].update(source={'kind': 'event', 'id': ''}),
            lambda value: value['experiences'][0].update(extra='secret'),
            lambda value: value['experiences'][0].update(captured_at=True),
            lambda value: value['experiences'][0].update(captured_at=float('nan')),
            lambda value: value['experiences'][0].update(text='x' * (reflection.MAX_TEXT + 1)),
            lambda value: value['request'].update(topic=''),
        )
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                context = self.context()
                mutate(context['reflection_input'])
                self.assert_rejected_before_calls(context)

    def test_reflection_errors_are_safe_and_stop_decision(self):
        for error, code in (
            (reflection.ReflectionError('provider_failed'), 'provider_failed'),
            (reflection.ReflectionError('invalid_config'), 'invalid_config'),
            (reflection.ReflectionError('rate_limited'), 'rate_limited'),
            (adapter.ModelError('rate_limited'), 'rate_limited'),
            (adapter.ModelError('timeout'), 'timeout'),
            (reflection.ReflectionError('unknown_source_id'), 'invalid_response'),
            (reflection.ReflectionError('secret-key private-provider'), 'invalid_response'),
            (RuntimeError('secret-key private-provider'), 'provider_failed'),
            (adapter.ModelError('secret-key private-provider'), 'internal_error'),
        ):
            with self.subTest(error=type(error).__name__, code=code):
                decision = mock.Mock()
                reflect = mock.Mock(side_effect=error)
                result = self.reply(self.context(), decision=decision, reflect=reflect)
                self.assertEqual(result, {'id': 7, 'ok': False, 'error': code})
                decision.assert_not_called()
                reflect.assert_called_once()

    def test_real_provider_failure_stops_decision(self):
        for code, expected in (('transport_error', 'provider_failed'),
                               ('rate_limited', 'rate_limited'), ('timeout', 'timeout')):
            with self.subTest(code=code):
                decision = mock.Mock()
                with mock.patch.object(adapter, '_transport', side_effect=adapter.ModelError(code)):
                    sink = io.StringIO()
                    bridge.serve(io.StringIO(json.dumps({'id': 7, 'context': self.context()}) + '\n'),
                                 sink, adapter.Config('https://example.test/v1', 'test', 'secret-key'),
                                 decision=decision)
                self.assertEqual(json.loads(sink.getvalue()),
                                 {'id': 7, 'ok': False, 'error': expected})
                decision.assert_not_called()

    def test_provider_proposal_with_unknown_sources_stops_decision(self):
        decision = mock.Mock()
        output = {'topic': 'the well', 'text': 'private', 'source_ids': ['unknown']}
        stream = ('data: ' + json.dumps({'type': 'response.completed', 'response': {
            'status': 'completed', 'output': [{'type': 'message', 'content': [
                {'type': 'output_text', 'text': json.dumps(output)}]}]}}) + '\n\n').encode()
        with mock.patch.object(adapter, '_transport', return_value=stream):
            sink = io.StringIO()
            bridge.serve(io.StringIO(json.dumps({'id': 7, 'context': self.context()}) + '\n'),
                         sink, adapter.Config('https://example.test/v1', 'test', 'secret-key'),
                         decision=decision)
        self.assertEqual(json.loads(sink.getvalue()),
                         {'id': 7, 'ok': False, 'error': 'invalid_response'})
        decision.assert_not_called()

    def test_real_reflection_and_decision_use_separate_provider_payloads(self):
        context = self.context()
        context.update(observation={'nearby_agents': [], 'has_target': False},
                       bounds={'min': {'x': -1, 'y': 0, 'z': -1},
                               'max': {'x': 1, 'y': 1, 'z': 1}})
        payloads = []
        proposal = {'topic': 'the well', 'text': 'Bob may help.', 'source_ids': ['l1-1']}

        def transport(_config, body):
            payloads.append(json.loads(json.loads(body)['input'][1]['content']))
            output = proposal if len(payloads) == 1 else {'kind': 'inspect'}
            return ('data: ' + json.dumps({'type': 'response.completed', 'response': {
                'status': 'completed', 'output': [{'type': 'message', 'content': [
                    {'type': 'output_text', 'text': json.dumps(output)}]}]}}) + '\n\n').encode()

        sink = io.StringIO()
        config = adapter.Config('https://example.test/v1', 'test', 'secret-key')
        with mock.patch.object(adapter, '_transport', side_effect=transport):
            bridge.serve(io.StringIO(json.dumps({'id': 7, 'context': context}) + '\n'),
                         sink, config,
                         decision=lambda cfg, ctx: adapter.decide(cfg, ctx, transport=transport))
        result = json.loads(sink.getvalue())
        self.assertTrue(result['ok'])
        self.assertEqual(result['reflection'], proposal)
        self.assertEqual(result['action']['kind'], 'inspect')
        self.assertEqual(payloads, [context['reflection_input'], {'model_input': context['model_input']}])
        self.assertNotEqual(result['audit']['context_sha256'], result['reflection_audit']['context_sha256'])

    def test_decision_failure_does_not_return_a_successful_reflection(self):
        reflection_audit = {'context_sha256': 'reflection-hash', 'usage': {'input_tokens': 4}}
        decision_audit = {'latency_ms': 12, 'usage': {}}
        result = self.reply(self.context(),
                            reflect=lambda *_: {'reflection': {'text': 'private'}, 'audit': reflection_audit},
                            decision=mock.Mock(side_effect=adapter.ModelError('rate_limited', decision_audit)))
        self.assertEqual(result, {'id': 7, 'ok': False, 'error': 'rate_limited',
                                  'audit': decision_audit, 'reflection_audit': reflection_audit})

    def test_spool_attempts_keep_reflection_audit_on_decision_failure(self):
        result = self.reply(self.context(),
                            reflect=lambda *_: {'reflection': {'text': 'private'},
                                                'audit': {'usage': {'input_tokens': 4}}},
                            decision=mock.Mock(side_effect=adapter.ModelError('rate_limited')))
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            root = Path(directory)
            request = root / 'request-7.json'
            request.write_text(json.dumps({'id': 7, 'context': self.context()}))
            runner = mock.Mock(return_value=result)
            with mock.patch.object(spool_worker.time, 'sleep'):
                spool_worker.process_one(root, request, 1, runner=runner)
            response = json.loads((root / 'response-7.json').read_text())
        self.assertEqual([attempt['reflection_audit'] for attempt in response['attempts']],
                         [result['reflection_audit']] * 3)
        self.assertEqual([attempt['error'] for attempt in response['attempts']],
                         ['rate_limited'] * 3)
        self.assertEqual(runner.call_count, 3)

    def test_decision_exception_keeps_only_this_requests_reflection_audit(self):
        source = io.StringIO(json.dumps({'id': 7, 'context': self.context()}) + '\n{broken\n')
        sink = io.StringIO()
        bridge.serve(source, sink, object(),
                     decision=mock.Mock(side_effect=RuntimeError('private-provider secret-key')),
                     reflection=lambda *_: {'reflection': {'text': 'private'}, 'audit': {'usage': {}}})
        self.assertEqual([json.loads(line) for line in sink.getvalue().splitlines()], [
            {'id': 7, 'ok': False, 'error': 'invalid_request', 'reflection_audit': {'usage': {}}},
            {'id': None, 'ok': False, 'error': 'invalid_request'},
        ])

    def test_no_reflection_preserves_legacy_and_envelope_requests(self):
        for context in ({'legacy': True}, {'model_input': self.envelope()}):
            with self.subTest(context=context):
                decision = mock.Mock(return_value={'action': {'kind': 'inspect'}, 'audit': {}})
                reflect = mock.Mock(side_effect=AssertionError('unexpected reflection'))
                result = self.reply(context, decision=decision, reflect=reflect)
                self.assertEqual(result, {'id': 7, 'ok': True, 'action': {'kind': 'inspect'}, 'audit': {}})
                self.assertEqual(decision.call_args.args[1], context)
                reflect.assert_not_called()

    def test_duplicate_reflection_fields_are_rejected_before_calls(self):
        encoded = json.dumps({'id': 7, 'context': self.context()})
        encoded = encoded.replace('"topic": "the well"', '"topic": "private", "topic": "the well"')
        decision, reflect = mock.Mock(), mock.Mock()
        sink = io.StringIO()
        bridge.serve(io.StringIO(encoded + '\n'), sink, object(), decision, reflect)
        self.assertEqual(json.loads(sink.getvalue())['error'], 'invalid_request')
        decision.assert_not_called()
        reflect.assert_not_called()

    def test_reflection_failure_does_not_poison_the_next_request(self):
        source = io.StringIO('\n'.join(json.dumps(request) for request in (
            {'id': 7, 'context': self.context()},
            {'id': 8, 'context': {'model_input': self.envelope()}},
        )) + '\n')
        sink = io.StringIO()
        decision = mock.Mock(return_value={'action': {'kind': 'inspect'}})
        reflect = mock.Mock(side_effect=reflection.ReflectionError('provider_failed'))
        bridge.serve(source, sink, object(), decision, reflect)
        self.assertEqual([json.loads(line) for line in sink.getvalue().splitlines()], [
            {'id': 7, 'ok': False, 'error': 'provider_failed'},
            {'id': 8, 'ok': True, 'action': {'kind': 'inspect'}},
        ])
        decision.assert_called_once()
        reflect.assert_called_once()

    def test_direct_worker_script_imports_reflection(self):
        script = Path(bridge.__file__).resolve()
        request = {'id': 7, 'context': {'reflection_input': self.context()['reflection_input']}}
        process = subprocess.run([sys.executable, str(script)],
                                 input=json.dumps(request) + '\n', text=True,
                                 capture_output=True, cwd=script.parent, timeout=5)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(json.loads(process.stdout),
                         {'id': 7, 'ok': False, 'error': 'invalid_request'})
        self.assertEqual(process.stderr, '')


if __name__ == '__main__':
    unittest.main()
