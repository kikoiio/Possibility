import io
import json
import unittest

from model import bridge


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


if __name__ == '__main__':
    unittest.main()
