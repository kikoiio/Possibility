"""Small on-disk fixtures for the product memory evidence boundary."""
import contextlib
import copy
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from validation.product_memory_audit import audit, checkpoint, main


class ProductMemoryFixture:
    """A durable reflection followed by a decision that retrieves it."""

    def __init__(self, root):
        self.root = Path(root)
        self.world = self.root / 'world'
        self.storage = self.world / 'mod_storage' / 'society'
        self.storage.parent.mkdir(parents=True)
        self.l1 = {
            'id': 'event:1:actor', 'layer': 'L1', 'owner': '0', 'time': 1,
            'text': 'I saw the well.', 'classification': 'experience',
            'source': {'kind': 'event', 'id': 'event:1'}, 'audience': ['0'],
        }
        self.rumor = {
            'id': 'rumor:1', 'layer': 'L1', 'owner': '0', 'time': 1,
            'text': 'I heard the well is safe.', 'classification': 'rumor',
            'source': {'kind': 'message', 'id': 'message:1'}, 'audience': ['0'],
        }
        self.belief = {
            'id': 'reflection:0:the well:1', 'layer': 'L2', 'owner': '0',
            'time': 2, 'text': 'I might revisit the well.', 'topic': 'the well',
            'source': {'kind': 'reflection', 'id': 'run-a:request:1'},
            'audience': ['0'], 'experiences': [self.l1['id']], 'version': 1,
        }
        self.saved = {
            'long_term': {'version': 1, 'records': [
                {'id': 'event:1', 'layer': 'L0', 'owner': 'world', 'time': 1,
                 'text': 'Alice inspected the well.', 'audience': ['public'],
                 'source': {'kind': 'action', 'id': '0'}},
                self.l1, self.rumor, self.belief,
            ]},
            'agents': [{'id': 0, 'decisions': 2,
                        'last_action': {'event_id': 'event:1'}}],
        }
        self.requests = {}
        self.responses = {}
        selected = {
            'schema': 'wispiva.reflection-input', 'version': 1,
            'request': {'world_id': 'world-1', 'actor_id': 'alice', 'topic': 'the well'},
            'experiences': [self.selected(row) for row in (self.l1, self.rumor)],
        }
        self.requests[('run-a', 1)] = {
            'id': 1, 'context': {'model_input': self.envelope(1), 'reflection_input': selected},
        }
        # Top-level usage repeats the final attempt and must not be counted twice.
        self.responses[('run-a', 1)] = {
            'id': 1, 'ok': True,
            'reflection': {'topic': self.belief['topic'], 'text': self.belief['text'],
                           'source_ids': [self.l1['id']]},
            'audit': self.usage(5, 3), 'reflection_audit': self.usage(7, 4),
            'attempts': [
                {'ok': False, 'audit': self.usage(2, 1), 'reflection_audit': self.usage(3, 2)},
                {'ok': True, 'audit': self.usage(5, 3), 'reflection_audit': self.usage(7, 4)},
            ],
        }
        self.requests[('run-a', 2)] = {
            'id': 2, 'context': {'model_input': self.envelope(2, belief=True, feedback=True)},
        }
        self.responses[('run-a', 2)] = {'id': 2, 'ok': True, 'audit': self.usage(11, 6)}

    @staticmethod
    def usage(inputs, outputs):
        return {'usage': {'input_tokens': inputs, 'output_tokens': outputs,
                          'total_tokens': inputs + outputs}}

    @staticmethod
    def selected(row):
        return {'id': row['id'], 'text': row['text'], 'source': copy.deepcopy(row['source']),
                'captured_at': row['time'], 'audience': ['alice']}

    def envelope(self, decision, *, belief=False, feedback=False):
        value = {
            'schema': 'wispiva.model-input', 'version': 1,
            'request': {'decision_id': f'decision:0:{decision}', 'world_id': 'world-1',
                        'actor_id': 'alice', 'origin_event_id': 'genesis:1',
                        'world_revision': 1, 'observed_at': decision},
            'actor': {
                'id': 'alice', 'runtime_id': 0.0, 'name': 'Alice',
                'role': {'text': 'scout', 'source': {'kind': 'genesis.role', 'id': 'role:alice'}},
                'goal': {'text': 'learn', 'source': {'kind': 'genesis.goal', 'id': 'goal:alice'}},
                'permissions': {'read_scopes': ['public', 'private'], 'allowed_actions': ['inspect']},
            },
            'knowledge': {'facts': [self.public_world_fact('alice')], 'experiences': [], 'rumors': [], 'unknowns': [],
                          'reflections': []},
            'current': {'observation': {}, 'inventory': {}, 'affordances': {}},
            'feedback': {'available': False},
        }
        if belief:
            value['knowledge']['reflections'] = [{
                'id': self.belief['id'], 'text': self.belief['text'], 'epistemic': 'belief',
                'source': {**self.belief['source'], 'revision': self.belief['version']},
                'access': {'scope': 'private', 'audience': ['alice']},
            }]
        if feedback:
            value['feedback'] = {
                'available': True, 'attempt_id': 'attempt:0:2', 'requested': {'kind': 'inspect'},
                'status': 'succeeded', 'reason': 'observed', 'event_id': 'event:1',
                'observed_at': 2, 'world_revision': 1,
            }
        return value

    @staticmethod
    def public_world_fact(actor):
        return {'id': 'genesis:world:genesis:1', 'text': 'World: River valley. Shared public setting.',
                'source': {'kind': 'genesis.public', 'id': 'genesis:1'},
                'epistemic': 'fact', 'access': {'scope': 'public', 'audience': [actor]}}

    def resume(self):
        before = self.root / 'before.json'
        before.write_text(json.dumps(self.saved))
        self.requests[('run-b', 3)] = {
            'id': 3, 'context': {'model_input': self.envelope(3, belief=True, feedback=True)},
        }
        self.responses[('run-b', 3)] = {'id': 3, 'ok': True, 'audit': self.usage(13, 7)}
        self.saved['agents'][0]['decisions'] = 3
        return before

    def write(self):
        # Luanti's mod storage is JSON containing the serialized checkpoint string.
        self.storage.write_text(json.dumps({'agent_state': json.dumps(self.saved)}))
        private = self.world / 'private'
        private.mkdir(parents=True, exist_ok=True)
        (private / 'wispiva-origin.json').write_text(json.dumps({
            'origin_event_id': 'genesis:1',
            'public': {'title': 'River valley', 'description': 'A shared public setting.'},
        }))
        for (run, request_id), value in self.requests.items():
            directory = self.world / 'private/model-audit' / run
            directory.mkdir(parents=True, exist_ok=True)
            (directory / f'request-{request_id}.json').write_text(json.dumps(value))
        for (run, request_id), value in self.responses.items():
            directory = self.world / 'private/model-audit' / run
            directory.mkdir(parents=True, exist_ok=True)
            (directory / f'response-{request_id}.json').write_text(json.dumps(value))


class ProductMemoryAuditTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='wispiva-memory-audit-')
        self.addCleanup(temporary.cleanup)
        self.fixture = ProductMemoryFixture(temporary.name)

    def run_audit(self, before=None):
        self.fixture.write()
        return audit(self.fixture.world, before)

    def assert_rejected(self, before=None):
        # Missing evidence may fail at file or durable-ID lookup; neither is success.
        with self.assertRaises((AssertionError, KeyError, FileNotFoundError, ValueError)):
            self.run_audit(before)

    def test_durable_writeback_usage_and_later_belief_retrieval(self):
        result = self.run_audit()
        self.assertEqual(result, {
            'requests': 2, 'reflection_calls': 1, 'durable_beliefs': 1,
            'retrieved_beliefs': 1, 'actors': ['alice'], 'resumed_actors': 0,
            'runs': ['run-a'],
            'usage': {'input_tokens': 28, 'output_tokens': 16, 'total_tokens': 44},
        })
        self.assertEqual(checkpoint(self.fixture.world), self.fixture.saved)

    def test_citations_may_be_a_strict_subset_of_selected_experiences(self):
        selected = self.fixture.requests[('run-a', 1)]['context']['reflection_input']['experiences']
        cited = self.fixture.responses[('run-a', 1)]['reflection']['source_ids']
        self.assertLess(set(cited), {row['id'] for row in selected})
        self.assertEqual(self.run_audit()['reflection_calls'], 1)

    def test_missing_shared_public_world_context_is_rejected(self):
        self.fixture.requests[('run-a', 1)]['context']['model_input']['knowledge']['facts'] = []
        self.assert_rejected()

    def test_resume_preserves_history_belief_and_first_action_feedback(self):
        before = self.fixture.resume()
        result = self.run_audit(before)
        self.assertEqual(result['resumed_actors'], 1)
        self.assertEqual(result['runs'], ['run-a', 'run-b'])
        self.assertEqual(result['requests'], 3)
        self.assertEqual(result['usage'], {'input_tokens': 41, 'output_tokens': 23, 'total_tokens': 64})

    def test_cross_owner_selected_experience_is_rejected(self):
        self.fixture.l1['owner'] = '1'
        self.fixture.l1['audience'] = ['1']
        self.assert_rejected()

    def test_cross_owner_writeback_is_rejected(self):
        self.fixture.belief['owner'] = '1'
        self.fixture.belief['audience'] = ['1']
        self.assert_rejected()

    def test_cross_owner_retrieved_belief_is_rejected(self):
        envelope = self.fixture.requests[('run-a', 2)]['context']['model_input']
        envelope['actor'].update(id='bob', runtime_id=1, name='Bob')
        envelope['request']['actor_id'] = 'bob'
        envelope['knowledge']['facts'][0]['access']['audience'] = ['bob']
        envelope['knowledge']['reflections'][0]['access']['audience'] = ['bob']
        self.assert_rejected()

    def test_selected_audience_must_match_stable_actor(self):
        selected = self.fixture.requests[('run-a', 1)]['context']['reflection_input']
        selected['experiences'][0]['audience'] = ['bob']
        self.assert_rejected()

    def test_missing_durable_selected_citation_is_rejected(self):
        records = self.fixture.saved['long_term']['records']
        records.remove(self.fixture.l1)
        self.assert_rejected()

    def test_missing_durable_belief_citation_is_rejected(self):
        self.fixture.belief['experiences'] = ['missing-l1']
        self.assert_rejected()

    def test_cross_owner_belief_citation_is_rejected(self):
        foreign = {**copy.deepcopy(self.fixture.l1), 'id': 'bob-l1', 'owner': '1', 'audience': ['1']}
        self.fixture.saved['long_term']['records'].append(foreign)
        self.fixture.belief['experiences'] = [foreign['id']]
        self.assert_rejected()

    def test_genesis_unknown_is_not_a_reflection_experience(self):
        self.fixture.l1['classification'] = 'unknown'
        self.assert_rejected()

    def test_source_must_be_selected_even_if_it_is_durable_and_owned(self):
        unselected = {**copy.deepcopy(self.fixture.l1), 'id': 'not-selected'}
        self.fixture.saved['long_term']['records'].append(unselected)
        self.fixture.responses[('run-a', 1)]['reflection']['source_ids'] = [unselected['id']]
        self.fixture.belief['experiences'] = [unselected['id']]
        self.assert_rejected()

    def test_empty_or_duplicate_source_ids_are_rejected(self):
        for ids in ([], [self.fixture.l1['id']] * 2):
            with self.subTest(ids=ids):
                self.fixture.responses[('run-a', 1)]['reflection']['source_ids'] = ids
                self.fixture.belief['experiences'] = ids
                self.assert_rejected()

    def test_no_subsequent_belief_retrieval_is_rejected(self):
        self.fixture.requests[('run-a', 2)]['context']['model_input']['knowledge']['reflections'] = []
        self.assert_rejected()

    def test_missing_response_is_rejected(self):
        del self.fixture.responses[('run-a', 2)]
        self.assert_rejected()

    def test_failed_or_mismatched_response_is_rejected(self):
        response = self.fixture.responses[('run-a', 2)]
        for field, value in (('ok', False), ('id', 99)):
            with self.subTest(field=field):
                original = response[field]
                response[field] = value
                self.assert_rejected()
                response[field] = original

    def test_missing_writeback_is_rejected(self):
        self.fixture.saved['long_term']['records'].remove(self.fixture.belief)
        self.assert_rejected()

    def test_duplicate_producer_writeback_is_rejected(self):
        duplicate = {**copy.deepcopy(self.fixture.belief), 'id': 'second-writeback', 'version': 2}
        self.fixture.saved['long_term']['records'].append(duplicate)
        self.assert_rejected()

    def test_unexplained_durable_reflection_is_rejected(self):
        unexplained = {**copy.deepcopy(self.fixture.belief), 'id': 'unexplained', 'topic': 'other',
                       'source': {'kind': 'reflection', 'id': 'unknown-producer'}}
        self.fixture.saved['long_term']['records'].append(unexplained)
        self.assert_rejected()

    def test_version_gap_and_mismatched_projected_revision_are_rejected(self):
        self.fixture.belief['version'] = 2
        projected = self.fixture.requests[('run-a', 2)]['context']['model_input']['knowledge']['reflections'][0]
        self.assert_rejected()
        projected['source']['revision'] = 2
        self.assert_rejected()

    def test_unsolicited_reflection_without_input_is_rejected(self):
        self.fixture.responses[('run-a', 2)]['reflection'] = copy.deepcopy(
            self.fixture.responses[('run-a', 1)]['reflection'])
        self.assert_rejected()

    def test_resume_rejects_altered_history(self):
        before = self.fixture.resume()
        self.fixture.rumor['text'] = 'rewritten history'
        self.assert_rejected(before)

    def test_resume_requires_old_belief_in_first_resumed_input(self):
        before = self.fixture.resume()
        resumed = self.fixture.requests[('run-b', 3)]['context']['model_input']
        resumed['knowledge']['reflections'] = []
        self.assert_rejected(before)

    def test_resume_requires_next_decision_counter(self):
        before = self.fixture.resume()
        self.fixture.requests[('run-b', 3)]['context']['model_input']['request']['decision_id'] = 'decision:0:4'
        self.assert_rejected(before)

    def test_resume_rejects_lost_action_feedback(self):
        before = self.fixture.resume()
        self.fixture.requests[('run-b', 3)]['context']['model_input']['feedback']['event_id'] = 'wrong-event'
        self.assert_rejected(before)

    def test_cli_writes_audit_and_checkpoint(self):
        self.fixture.write()
        output, saved = self.fixture.root / 'audit.json', self.fixture.root / 'saved.json'
        arguments = ['product_memory_audit', '--world', str(self.fixture.world),
                     '--output', str(output), '--save-checkpoint', str(saved)]
        stdout = io.StringIO()
        with patch('sys.argv', arguments), contextlib.redirect_stdout(stdout):
            main()
        self.assertEqual(json.loads(output.read_text()), json.loads(stdout.getvalue()))
        self.assertEqual(json.loads(saved.read_text()), self.fixture.saved)


if __name__ == '__main__':
    unittest.main()
