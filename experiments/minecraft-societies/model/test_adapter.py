import asyncio
import json
import unittest
from unittest import mock

import adapter


CONFIG = adapter.Config('https://example.invalid/v1', 'test-model', 'secret-key')
CTX = {'observation': {'has_target': False, 'nearby_agents': [2, 3]},
       'bounds': {'min': {'x': -5, 'y': 1, 'z': -5}, 'max': {'x': 5, 'y': 1, 'z': 5}}}


def stream(action, status='completed'):
    events = [{'type': 'response.output_text.delta', 'delta': json.dumps(action)},
              {'type': 'response.completed', 'response': {'status': status,
               'usage': {'input_tokens': 12, 'output_tokens': 4, 'ignored': 'secret-key'}}}]
    return ''.join('data: ' + json.dumps(e) + '\n\n' for e in events).encode()


class AdapterTests(unittest.TestCase):
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

    def test_actions_and_context_constraints(self):
        valid = [{'kind': 'inspect'}, {'kind': 'mark'}, {'kind': 'wander', 'point': {'x': 5, 'y': 1, 'z': -5}}]
        for action in valid:
            with self.subTest(action=action):
                self.assertEqual(adapter._validate_action(json.dumps(action), CTX)['kind'], action['kind'])
        invalid = [{'kind': 'advance'}, {'kind': 'approach', 'target': 4},
                   {'kind': 'approach', 'target': True}, {'kind': 'mark', 'why': 'injection'},
                   {'kind': 'wander', 'point': {'x': 6, 'y': 1, 'z': 0}},
                   {'kind': 'wander', 'point': {'x': 0, 'y': 2, 'z': 0}}]
        for action in invalid:
            with self.subTest(action=action), self.assertRaisesRegex(adapter.ModelError, 'invalid_action'):
                adapter._validate_action(json.dumps(action), CTX)
        with self.assertRaises(adapter.ModelError):
            adapter._validate_action('{"kind":"inspect","kind":"mark"}', CTX)
        self.assertEqual(adapter._validate_action('{"kind":"advance"}', {**CTX, 'observation': {'has_target': True}})['kind'], 'advance')

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
        result = asyncio.run(adapter.decide_async(CONFIG, CTX, transport=lambda *_: stream({'kind': 'inspect'})))
        self.assertEqual(result['action']['kind'], 'inspect')

    def test_transport_error_is_sanitized(self):
        with mock.patch('urllib.request.build_opener', side_effect=ValueError('secret-key')):
            with self.assertRaises(adapter.ModelError) as caught:
                adapter.decide(CONFIG, CTX)
        self.assertNotIn('secret-key', str(caught.exception))

class BridgeTests(unittest.TestCase):
    def test_protocol_and_failure_paths_without_credentials(self):
        import io
        import bridge
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
        import bridge
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
