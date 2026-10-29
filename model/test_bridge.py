import io
import json
import unittest

from model import bridge


class BridgeEnvelopeTests(unittest.TestCase):
    def envelope(self):
        return {
            'schema': 'wispiva.model-input', 'version': 1,
            'request': {'world_id': 'world-1', 'actor_id': 'alice'},
            'actor': {'id': 'alice'},
            'knowledge': {'facts': [], 'experiences': [], 'rumors': [], 'unknowns': []},
            'current': {}, 'feedback': {'available': False},
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


if __name__ == '__main__':
    unittest.main()
