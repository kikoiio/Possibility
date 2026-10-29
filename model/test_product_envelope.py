import unittest

from model.product_envelope import EnvelopeError, validate


def envelope():
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


class ProductEnvelopeTests(unittest.TestCase):
    def test_valid_envelope(self):
        self.assertTrue(validate(envelope()))

    def test_knowledge_requires_source_and_actor_audience(self):
        value = envelope()
        value['knowledge']['rumors'].append({
            'id': 'rumor-1', 'text': 'heard', 'epistemic': 'rumor',
            'source': {'kind': 'message', 'id': 'message-1'},
            'access': {'scope': 'direct', 'audience': ['bob']},
        })
        with self.assertRaises(EnvelopeError):
            validate(value)

    def test_knowledge_ids_and_epistemic_sections_are_consistent(self):
        value = envelope()
        record = {'id': 'same', 'text': 'one', 'epistemic': 'fact',
                  'source': {'kind': 'world-event', 'id': 'event-1'},
                  'access': {'scope': 'public', 'audience': ['alice']}}
        value['knowledge']['facts'].append(record)
        value['knowledge']['experiences'].append({**record, 'epistemic': 'experience'})
        with self.assertRaises(EnvelopeError):
            validate(value)
        value['knowledge']['experiences'][0]['id'] = 'experience-1'
        value['knowledge']['facts'][0]['epistemic'] = 'rumor'
        with self.assertRaises(EnvelopeError):
            validate(value)

    def test_feedback_and_json_budget_are_bounded(self):
        value = envelope()
        value['feedback'] = {'available': True, 'attempt_id': 'attempt-1',
                             'requested': {'kind': 'inspect'}, 'status': 'succeeded',
                             'reason': 'ok', 'event_id': 'event-2',
                             'observed_at': 101.0, 'world_revision': 2}
        self.assertTrue(validate(value))
        value['feedback']['status'] = 'invalid'
        with self.assertRaises(EnvelopeError):
            validate(value)
        value = envelope()
        value['actor']['name'] = 'x' * 16000
        with self.assertRaises(EnvelopeError):
            validate(value)

    def test_non_standard_numbers_are_rejected(self):
        value = envelope()
        value['request']['observed_at'] = float('nan')
        with self.assertRaises(EnvelopeError):
            validate(value)


if __name__ == '__main__':
    unittest.main()
