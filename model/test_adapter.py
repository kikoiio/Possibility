import asyncio
import io
import json
import traceback
import unittest
from unittest import mock

from model import adapter


CONFIG = adapter.Config('https://example.invalid/v1', 'test-model', 'secret-key')
CTX = {'observation': {'has_target': False, 'nearby_agents': [2, 3]},
       'bounds': {'min': {'x': -5, 'y': 1, 'z': -5}, 'max': {'x': 5, 'y': 1, 'z': 5}}}


def product_envelope():
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


def stream(action, status='completed', *, usage=None):
    events = [{'type': 'response.output_text.delta', 'delta': json.dumps(action)},
              {'type': 'response.completed', 'response': {'status': status,
               'usage': {'input_tokens': 12, 'output_tokens': 4, 'ignored': 'secret-key'}
               if usage is None else usage}}]
    return ''.join('data: ' + json.dumps(e) + '\n\n' for e in events).encode()


class AdapterTests(unittest.TestCase):
    def test_lua_integral_numbers_are_accepted_without_accepting_booleans(self):
        ctx = {'observation': {'nearby_agents': [2.0]},
               'bounds': {'min': {'x': -5.0, 'y': 1.0, 'z': -5.0},
                          'max': {'x': 5.0, 'y': 1.0, 'z': 5.0}}}
        result = adapter.decide(CONFIG, ctx, transport=lambda *_: stream({'kind': 'approach', 'target': 2}))
        self.assertEqual(result['action']['target'], 2)
        ctx['observation']['nearby_agents'] = [True]
        with self.assertRaises(adapter.ModelError):
            adapter.decide(CONFIG, ctx, transport=lambda *_: stream({'kind': 'inspect'}))
    def test_message_only_to_observed_agent_with_bounded_text(self):
        context = {'observation': {'nearby_agents': [2]}}
        self.assertEqual(adapter._validate_action('{"kind":"say","target":2,"text":"hello"}', context)['kind'], 'say')
        for text in ('{"kind":"say","target":3,"text":"hello"}',
                     '{"kind":"say","target":2,"text":""}',
                     '{"kind":"say","target":2,"text":"bad\\nmessage"}'):
            with self.assertRaises(adapter.ModelError):
                adapter._validate_action(text, context)
    def test_request_and_audit(self):
        def transport(config, body):
            req = json.loads(body)
            self.assertEqual(req['model'], 'test-model')
            self.assertTrue(req['stream'])
            self.assertNotIn('secret-key', body.decode())
            return stream({'kind': 'approach', 'target': 2})
        result = adapter.decide(CONFIG, CTX, transport=transport)
        self.assertEqual(result['action'], {'kind': 'approach', 'target': 2, 'why': 'model'})
        self.assertEqual(result['audit']['usage'], {'input_tokens': 12, 'output_tokens': 4})
        self.assertNotIn('secret-key', repr(result))
        self.assertNotIn('secret-key', repr(CONFIG))

    def test_product_envelope_is_the_only_provider_context(self):
        envelope = product_envelope()
        context = {**CTX, 'model_input': envelope, 'genesis_profile': {'memory_seeds': ['private']},
                   'incoming_messages': [{'text': 'private'}]}
        def transport(_config, body):
            request = json.loads(body)
            payload = json.loads(request['input'][1]['content'])
            self.assertEqual(payload, {'model_input': envelope})
            return stream({'kind': 'inspect'})
        self.assertEqual(adapter.decide(CONFIG, context, transport=transport)['action']['kind'], 'inspect')

    def test_invalid_product_envelope_is_rejected_before_provider(self):
        context = {**CTX, 'model_input': product_envelope()}
        context['model_input']['actor']['permissions']['read_scopes'] = []
        with self.assertRaisesRegex(adapter.ModelError, '^invalid_context$'):
            adapter.decide(CONFIG, context, transport=lambda *_: self.fail('provider called'))

    def test_invalid_present_token_fields_are_marked_while_valid_counts_survive(self):
        valid = {'input_tokens': 12, 'output_tokens': 4, 'total_tokens': 16}
        for field in valid:
            for value in (None, True, False, -1, 10**9 + 1, 12.0, 0.5,
                          float('nan'), float('inf'), -float('inf'), 'private-count', {}, []):
                with self.subTest(field=field, value=value):
                    usage = {**valid, field: value, 'ignored': 'secret-key'}
                    result = adapter.decide(
                        CONFIG, CTX, transport=lambda *_: stream({'kind': 'inspect'}, usage=usage),
                    )
                    expected = {**valid, 'invalid': True}
                    del expected[field]
                    self.assertEqual(result['audit']['usage'], expected)
                    self.assertEqual(result['action'], {'kind': 'inspect', 'why': 'model'})
                    self.assertNotIn('secret-key', repr(result))
                    self.assertNotIn('private-count', repr(result))

    def test_absent_token_fields_and_valid_boundary_counts_keep_existing_semantics(self):
        for usage, expected in (
            ({}, {}),
            ({'input_tokens': 12}, {'input_tokens': 12}),
            ({'input_tokens': 0, 'output_tokens': 10**9, 'total_tokens': 10**9},
             {'input_tokens': 0, 'output_tokens': 10**9, 'total_tokens': 10**9}),
            ({'input_tokens': 12, 'output_tokens': 4, 'invalid': True, 'ignored': 'secret-key'},
             {'input_tokens': 12, 'output_tokens': 4}),
        ):
            with self.subTest(usage=usage):
                result = adapter.decide(
                    CONFIG, CTX, transport=lambda *_: stream({'kind': 'inspect'}, usage=usage),
                )
                self.assertEqual(result['audit']['usage'], expected)

    def test_invalid_usage_marker_survives_invalid_action_audit(self):
        usage = {'input_tokens': 12, 'output_tokens': 4, 'total_tokens': 'private-count'}
        with self.assertRaisesRegex(adapter.ModelError, '^invalid_action$') as caught:
            adapter.decide(CONFIG, CTX, transport=lambda *_: stream({'kind': 'advance'}, usage=usage))
        self.assertEqual(caught.exception.audit['usage'],
                         {'input_tokens': 12, 'output_tokens': 4, 'invalid': True})
        self.assertNotIn('private-count', repr(caught.exception.audit))

    def test_actions_and_context_constraints(self):
        valid = [{'kind': 'inspect'}, {'kind': 'mark'}, {'kind': 'wander', 'point': {'x': 5, 'y': 1, 'z': -5}},
                 {'kind': 'gather', 'point': {'x': 0, 'y': 1, 'z': 0}},
                 {'kind': 'build', 'point': {'x': 0, 'y': 1, 'z': 0}}]
        for action in valid:
            with self.subTest(action=action):
                self.assertEqual(adapter._validate_action(json.dumps(action), CTX)['kind'], action['kind'])
        invalid = [{'kind': 'advance'}, {'kind': 'approach', 'target': 4},
                   {'kind': 'approach', 'target': True},
                   {'kind': 'wander', 'point': {'x': 6, 'y': 1, 'z': 0}},
                   {'kind': 'wander', 'point': {'x': 0, 'y': 2, 'z': 0}}]
        for action in invalid:
            with self.subTest(action=action), self.assertRaisesRegex(adapter.ModelError, 'invalid_action'):
                adapter._validate_action(json.dumps(action), CTX)
        with self.assertRaises(adapter.ModelError):
            adapter._validate_action('{"kind":"inspect","kind":"mark"}', CTX)
        self.assertEqual(adapter._validate_action('{"kind":"advance"}', {**CTX, 'observation': {'has_target': True}})['kind'], 'advance')

    def test_projection_removes_untrusted_fields_and_normalizes_numbers(self):
        raw = {'kind': 'build', 'point': {'x': 0.0, 'y': 1.0, 'z': -2.0, 'url': 'evil'},
               'node': 'forbidden:node', 'why': 'fixture', 'url': 'https://evil.invalid'}
        result = adapter._validate_action(json.dumps(raw), CTX)
        self.assertEqual(result, {'kind': 'build', 'point': {'x': 0, 'y': 1, 'z': -2}, 'why': 'model'})
        self.assertEqual(adapter._validate_action('{"kind":"mark","why":"injection"}', CTX),
                         {'kind': 'mark', 'why': 'model'})
        for value in (True, 0.5, float('inf'), 10**400):
            raw['point']['x'] = value
            with self.assertRaises(adapter.ModelError):
                adapter._validate_action(json.dumps(raw), CTX)

    def test_fail_closed_stream(self):
        for raw in [b'', b'data: {bad}\n\n', stream({'kind': 'mark'}, 'incomplete'),
                    b'data: {"type":"response.failed"}\n\n', stream({'kind': 'mark'})[:-20],
                    b'x' * (adapter.MAX_STREAM + 1)]:
            with self.subTest(size=len(raw)), self.assertRaises(adapter.ModelError):
                adapter.decide(CONFIG, CTX, transport=lambda *_: raw)

    def test_config_and_redirect_policy(self):
        env = {'XUNFEI_BASE_URL': 'https://api.example/v1/responses', 'XUNFEI_MODEL': 'm', 'XUNFEI_API_KEY': 'k'}
        self.assertEqual(adapter.Config.from_env(env).endpoint(), env['XUNFEI_BASE_URL'])
        env['XUNFEI_OPENAI_RESPONSE_URL'] = 'https://api.example/custom/endpoint'
        self.assertEqual(adapter.Config.from_env(env).endpoint(), env['XUNFEI_OPENAI_RESPONSE_URL'])
        self.assertEqual(CONFIG.endpoint(), 'https://example.invalid/v1/responses')
        for url in ['http://example.com', 'https://user:pass@example.com', 'https://example.com/?key=secret']:
            with self.assertRaisesRegex(adapter.ModelError, 'invalid_config'):
                adapter.Config(url, 'm', 'secret').endpoint()
        self.assertIsNone(adapter._NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.invalid'))

    def test_no_exception_leak_and_async(self):
        def broken(*_):
            raise RuntimeError('secret-key')
        with self.assertRaises(adapter.ModelError) as caught:
            adapter.decide(CONFIG, CTX, transport=broken)
        self.assertNotIn('secret-key', str(caught.exception))
        self.assertIsInstance(caught.exception.audit['latency_ms'], int)
        self.assertEqual(caught.exception.audit['usage'], {})
        result = asyncio.run(adapter.decide_async(CONFIG, CTX, transport=lambda *_: stream({'kind': 'inspect'})))
        self.assertEqual(result['action']['kind'], 'inspect')

    def test_transport_error_is_sanitized(self):
        with mock.patch('urllib.request.build_opener', side_effect=ValueError('secret-key')):
            with self.assertRaises(adapter.ModelError) as caught:
                adapter.decide(CONFIG, CTX)
        self.assertNotIn('secret-key', str(caught.exception))

    def test_http_429_is_rate_limited_and_other_http_errors_remain_transport_errors(self):
        for status, expected in ((429, 'rate_limited'), (401, 'transport_error'),
                                 (403, 'transport_error'), (500, 'transport_error')):
            with self.subTest(status=status):
                failure = adapter.urllib.error.HTTPError(
                    'https://private-provider.invalid/?key=secret-key', status,
                    'private-provider-message', {'Retry-After': 'private-header'},
                    io.BytesIO(b'private-provider-payload'),
                )
                self.addCleanup(failure.close)
                with mock.patch('urllib.request.build_opener') as build_opener:
                    build_opener.return_value.open.side_effect = failure
                    with self.assertRaises(adapter.ModelError) as caught:
                        adapter.decide(CONFIG, CTX)
                    build_opener.return_value.open.assert_called_once()
                error = caught.exception
                self.assertEqual(error.args, (expected,))
                self.assertEqual(error.audit['usage'], {})
                self.assertIsInstance(error.audit['latency_ms'], int)
                rendered = ''.join(traceback.format_exception(type(error), error, error.__traceback__))
                for private in ('private-provider', 'private-header', 'secret-key'):
                    self.assertNotIn(private, str(error) + repr(error.audit) + rendered)

class BridgeTests(unittest.TestCase):
    def test_protocol_and_failure_paths_without_credentials(self):
        import io
        from model import bridge
        def decision(config, context):
            return adapter.decide(config, context, transport=lambda *_: stream({'kind': 'inspect'}))
        lines = [json.dumps({'id': 7, 'context': CTX}), '{broken',
                 json.dumps({'id': 8, 'context': CTX}),
                 json.dumps({'id': 'secret-key', 'context': CTX})]
        output = io.StringIO()
        bridge.serve(io.StringIO('\n'.join(lines) + '\n'), output, CONFIG, decision)
        replies = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([(r['id'], r['ok']) for r in replies], [(7, True), (None, False), (8, True), (None, False)])
        self.assertNotIn('secret-key', output.getvalue())
        self.assertEqual(replies[1]['error'], 'invalid_request')

    def test_provider_failure_and_large_line(self):
        import io
        from model import bridge
        def failure(*_):
            raise adapter.ModelError('provider_failed')
        output = io.StringIO()
        request = json.dumps({'id': 1, 'context': {}})
        bridge.serve(io.StringIO('x' * (bridge.MAX_LINE + 5) + '\n' + request + '\n'), output, CONFIG, failure)
        replies = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(replies, [{'id': None, 'ok': False, 'error': 'invalid_request'},
                                   {'id': 1, 'ok': False, 'error': 'provider_failed'}])


if __name__ == '__main__':
    unittest.main()
