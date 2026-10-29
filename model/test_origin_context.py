import copy
import json
from pathlib import Path
import unittest

from model import adapter, origin_context
from world.origin import create_origin_event, draft_sha256


WORLD = '12345678-1234-4234-8234-123456789abc'
CONFIG = adapter.Config('https://example.invalid/v1', 'fixture', 'key')


class OriginContextTests(unittest.TestCase):
    def setUp(self):
        draft = json.loads((Path(__file__).parent.parent / 'genesis/example.json').read_text())
        draft['actors'].append({'id': 'alice', 'name': 'Alice', 'role': 'friend',
                                'goal': 'alice private goal', 'placeId': 'bank'})
        draft['actors'][0]['goal'] = 'traveler private goal'
        draft['memories'] = [{'actorId': 'alice', 'text': 'alice private memory'},
                             {'actorId': 'traveler', 'text': 'traveler private memory'}]
        self.event = create_origin_event(WORLD, {'draft_id': 'draft', 'draft_revision': 1,
            'draft_sha256': draft_sha256(draft), 'operation_id': 'origin-1',
            'status': 'confirmed', 'draft': draft})
        # A valid persisted mapping deliberately different from sorted allocation.
        self.event['data']['origin']['runtime_ids'] = {'alice': 2, 'traveler': 1}
        self.local = {'observation': {'has_target': False, 'nearby_agents': [0],
                                      'pos': {'x': 0, 'y': 1, 'z': 0}},
                      'bounds': {'min': {'x': -5, 'y': 1, 'z': -5},
                                 'max': {'x': 5, 'y': 1, 'z': 5}},
                      'incoming_messages': [{'sender_id': 0, 'text': 'hello'}],
                      'feedback': [{'kind': 'inspect', 'success': True}]}
        self.calls = []
        self.response_action = {'kind': 'inspect'}

    def binding(self, actor='alice'):
        mapping = copy.deepcopy(self.event['data']['origin']['runtime_ids'])
        return {'contract_version': 1, 'world_id': WORLD, 'origin_event_id': 'origin-1',
                'draft_sha256': self.event['data']['draft_sha256'], 'actor_id': actor,
                'runtime_ids': mapping, 'luanti_id': mapping[actor] - 1}

    def transport(self, config, body):
        self.calls.append(json.loads(body))
        events = [{'type': 'response.output_text.delta', 'delta': json.dumps(self.response_action)},
                  {'type': 'response.completed', 'response': {'status': 'completed'}}]
        return ''.join('data: ' + json.dumps(event) + '\n\n' for event in events).encode()

    def invoke(self, event=None, binding=None, local=None):
        return origin_context.decide(CONFIG, self.event if event is None else event,
            self.binding() if binding is None else binding,
            self.local if local is None else local, transport=self.transport)

    def test_fixture_transport_isolates_actors_and_preserves_sources(self):
        self.invoke()
        local = copy.deepcopy(self.local)
        local['observation']['nearby_agents'] = [1]
        local['incoming_messages'] = [{'sender_id': 1, 'text': 'reply'}]
        self.invoke(binding=self.binding('traveler'), local=local)
        alice, traveler = [json.loads(call['input'][1]['content']) for call in self.calls]
        self.assertEqual(alice['self_id'], 1)
        self.assertEqual(traveler['self_id'], 0)
        for context, own, other in ((alice, 'alice', 'traveler'), (traveler, 'traveler', 'alice')):
            encoded = json.dumps(context)
            self.assertIn(own + ' private memory', encoded)
            self.assertIn(own + ' private goal', encoded)
            self.assertNotIn(other + ' private memory', encoded)
            self.assertNotIn(other + ' private goal', encoded)
            self.assertEqual(context['world_id'], WORLD)
            self.assertEqual(context['self']['memories'][0]['seed_id'], f'origin-1:seed:{own}:0')
            self.assertEqual(context['self']['memories'][0]['source'],
                             {'event_id': 'origin-1', 'kind': 'genesis.seed'})
            self.assertEqual(context['memory'][0]['owner'], own)
            self.assertEqual(context['memory'][0]['known_by'], [own])
            self.assertEqual(context['memory'][0]['classification'], 'unknown')

    def test_binding_failures_never_call_transport(self):
        cases = [('contract_version', True), ('contract_version', 2),
                 ('world_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
                 ('origin_event_id', 'other'), ('draft_sha256', '0' * 64),
                 ('actor_id', 'stranger'), ('luanti_id', 0), ('luanti_id', True),
                 ('runtime_ids', {'alice': 1, 'traveler': 2}),
                 ('runtime_ids', {'alice': True, 'traveler': 1}),
                 ('runtime_ids', {'alice': 2})]
        for key, value in cases:
            binding = self.binding(); binding[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(origin_context.ContextError):
                self.invoke(binding=binding)
        event = copy.deepcopy(self.event)
        event['data']['origin']['draft']['memories'][0]['text'] = 'tampered'
        with self.assertRaises(origin_context.ContextError):
            self.invoke(event=event)
        self.assertEqual(self.calls, [])

    def test_persisted_private_seeds_are_retrievable_in_model_loop(self):
        event = copy.deepcopy(self.event)
        draft = event['data']['origin']['draft']
        draft['memories'] = [
            {'actorId': 'alice', 'text': 'unrelated childhood garden'},
            {'actorId': 'traveler', 'text': 'amber traveler secret'},
            {'actorId': 'alice', 'text': 'amber key hidden at harbor'},
        ]
        event['data']['draft_sha256'] = draft_sha256(draft)
        binding = self.binding()
        binding['draft_sha256'] = event['data']['draft_sha256']
        # Simulate the manifest payload after persistence, without engine or I/O.
        restored = json.loads(json.dumps(event))
        expected = origin_context.retrieve_genesis_memories(
            event, binding, query='amber harbor', max_entries=1)
        self.assertEqual(origin_context.retrieve_genesis_memories(
            restored, binding, query='amber harbor', max_entries=1), expected)
        manifest = {'format': 'wispiva-world-creation-materials', 'version': 1,
                    'world_id': WORLD, 'origin_event': restored,
                    'projection': {'private_actors': {'traveler': 'amber traveler secret'}},
                    'confirmation': {'private': 'all actor draft secret'}}
        projected = origin_context.build_manifest_context(
            json.loads(json.dumps(manifest)), binding, self.local,
            memory_query='amber harbor', max_memory_entries=1)
        origin_context.decide(CONFIG, restored, binding, self.local,
                              memory_query='amber harbor', max_memory_entries=1,
                              transport=self.transport)
        context = json.loads(self.calls[-1]['input'][1]['content'])
        self.assertEqual(context, projected)
        self.assertNotIn('all actor draft secret', json.dumps(context))
        self.assertEqual(context['memory'], expected['memory'])
        self.assertEqual(context['memory_query'], 'amber harbor')
        self.assertEqual(context['memory_scope']['available'], 2)
        self.assertEqual(context['memory_scope']['omitted'], 1)
        record, = context['memory']
        self.assertEqual(record, {
            'world_id': WORLD, 'seed_id': 'origin-1:seed:alice:1', 'owner': 'alice',
            'text': 'amber key hidden at harbor',
            'source': {'event_id': 'origin-1', 'kind': 'genesis.seed',
                       'id': 'origin-1:seed:alice:1'},
            'known_by': ['alice'], 'classification': 'unknown',
            'time': None, 'importance': None,
        })
        encoded = json.dumps(context)
        self.assertNotIn('amber traveler secret', encoded)
        self.assertNotIn('unrelated childhood garden', encoded)
        self.assertNotIn('traveler private goal', encoded)
        self.assertEqual([seed['seed_id'] for seed in context['self']['memories']],
                         [record['seed_id']])
        self.assertEqual(restored, event)
        record['known_by'].append('traveler')
        self.assertEqual(origin_context.retrieve_genesis_memories(
            restored, binding, query='amber harbor', max_entries=1), expected)

    def test_seed_retrieval_byte_limits_and_empty_owner(self):
        selected = origin_context.retrieve_genesis_memories(self.event, self.binding())
        size = len(json.dumps(selected['memory'], ensure_ascii=True, sort_keys=True,
                              separators=(',', ':')).encode('ascii'))
        self.assertEqual(selected['memory_scope']['bytes'], size)
        self.assertEqual(origin_context.retrieve_genesis_memories(
            self.event, self.binding(), max_bytes=size)['memory'], selected['memory'])
        for options in ({'max_memory_bytes': size - 1}, {'max_memory_entries': 0}):
            context = origin_context.build_context(self.event, self.binding(), self.local, **options)
            self.assertEqual(context['memory'], [])
            self.assertEqual(context['self']['memories'], [])
            self.assertEqual(context['memory_scope']['omitted'], 1)
            self.assertEqual(context['memory_scope']['bytes'], 2)
            self.assertNotIn('alice private memory', json.dumps(context))
        event = copy.deepcopy(self.event)
        draft = event['data']['origin']['draft']
        draft['memories'] = [m for m in draft['memories'] if m['actorId'] != 'alice']
        event['data']['draft_sha256'] = draft_sha256(draft)
        binding = self.binding(); binding['draft_sha256'] = event['data']['draft_sha256']
        result = origin_context.retrieve_genesis_memories(event, binding, query='traveler')
        self.assertEqual(result['memory'], [])
        self.assertEqual(result['memory_scope']['available'], 0)
        self.assertNotIn('traveler private memory', json.dumps(result))

    def test_invalid_retrieval_options_fail_before_transport(self):
        for options in ({'memory_query': None}, {'memory_query': 'x' * 513},
                        {'max_memory_entries': True}, {'max_memory_entries': 9},
                        {'max_memory_bytes': 1}, {'max_memory_bytes': 4097}):
            with self.subTest(options=options), self.assertRaises(origin_context.ContextError):
                origin_context.decide(CONFIG, self.event, self.binding(), self.local,
                                      transport=self.transport, **options)
        self.assertEqual(self.calls, [])

    def test_manifest_envelope_and_origin_binding_fail_closed(self):
        manifest = {'format': 'wispiva-world-creation-materials', 'version': 1,
                    'world_id': WORLD, 'origin_event': self.event}
        for field, value in (('format', 'genesis-disposable-preview'), ('version', True),
                             ('version', 2), ('world_id', None),
                             ('world_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
                             ('origin_event', {})):
            invalid = {**manifest, field: value}
            with self.subTest(field=field, value=value), self.assertRaises(origin_context.ContextError):
                origin_context.build_manifest_context(invalid, self.binding(), self.local)
        binding = self.binding(); binding['actor_id'] = 'stranger'
        with self.assertRaises(origin_context.ContextError):
            origin_context.build_manifest_context(manifest, binding, self.local)

    def test_saved_mapping_survives_serialization_and_is_not_reallocated(self):
        restored = json.loads(json.dumps(self.event))
        self.invoke(event=restored)
        context = json.loads(self.calls[0]['input'][1]['content'])
        self.assertEqual(context['self_id'], 1)
        self.assertEqual(context['observation']['nearby_agents'], [0])
        self.assertEqual(origin_context.build_context(restored, self.binding(), self.local),
                         origin_context.build_context(self.event, self.binding(), self.local))

    def test_observer_position_accepts_finite_fractional_coordinates(self):
        local = copy.deepcopy(self.local)
        local['observation']['pos'] = {'x': 0.25, 'y': 1.0, 'z': -0.5}
        self.invoke(local=local)
        self.assertEqual(json.loads(self.calls[0]['input'][1]['content'])['observation']['pos'],
                         local['observation']['pos'])
        for invalid in (float('inf'), float('nan'), True):
            local['observation']['pos']['x'] = invalid
            with self.subTest(invalid=invalid), self.assertRaises(origin_context.ContextError):
                self.invoke(local=local)
        self.assertEqual(len(self.calls), 1)

    def test_unknown_fields_and_invalid_local_data_are_rejected(self):
        cases = []
        for path in ((), ('observation',), ('bounds',), ('bounds', 'min'),
                     ('incoming_messages', 0), ('feedback', 0)):
            local = copy.deepcopy(self.local); target = local
            for part in path: target = target[part]
            target['private_other_actor'] = 'secret'; cases.append(local)
        for key, value in [('has_target', 1), ('nearby_agents', [1]),
                           ('nearby_agents', [0, 0]), ('nearby_agents', [True])]:
            local = copy.deepcopy(self.local); local['observation'][key] = value; cases.append(local)
        local = copy.deepcopy(self.local); local['incoming_messages'][0]['sender_id'] = 1; cases.append(local)
        local = copy.deepcopy(self.local); local['feedback'][0]['success'] = 1; cases.append(local)
        local = copy.deepcopy(self.local); local['bounds']['min']['x'] = 6; cases.append(local)
        for local in cases:
            with self.subTest(local=local), self.assertRaises(origin_context.ContextError):
                self.invoke(local=local)
        binding = self.binding(); binding['extra'] = 'secret'
        with self.assertRaises(origin_context.ContextError): self.invoke(binding=binding)
        self.assertEqual(self.calls, [])

    def test_budgets_reject_instead_of_truncating(self):
        for messages in ([{'sender_id': 0, 'text': 'x'}] * (origin_context.MAX_ITEMS + 1),
                         [{'sender_id': 0, 'text': '界' * 171}],
                         [{'sender_id': 0, 'text': '界' * 170}] * origin_context.MAX_ITEMS):
            local = copy.deepcopy(self.local); local['incoming_messages'] = messages
            with self.subTest(count=len(messages)), self.assertRaises(origin_context.ContextError):
                self.invoke(local=local)
        self.assertEqual(self.calls, [])

    def test_origin_memory_count_is_also_bounded(self):
        event = copy.deepcopy(self.event)
        draft = event['data']['origin']['draft']
        draft['memories'] = [{'actorId': 'alice', 'text': 'seed'}] * (origin_context.MAX_ITEMS + 1)
        event['data']['draft_sha256'] = draft_sha256(draft)
        binding = self.binding(); binding['draft_sha256'] = event['data']['draft_sha256']
        with self.assertRaises(origin_context.ContextError):
            self.invoke(event=event, binding=binding)
        self.assertEqual(self.calls, [])

    def test_resource_candidates_reach_adapter_and_selected_points_succeed(self):
        local = copy.deepcopy(self.local)
        local['local_actions'] = {
            'gather_points': [{'x': 1, 'y': 1, 'z': 0}],
            'build_points': [{'x': 0, 'y': 1, 'z': 1}],
            'reach': 1.5,
            'movement': 'wander or approach sets a destination; advance moves toward it',
            'sensing': 'local radius, no line-of-sight occlusion; sampled state can change',
        }
        for kind in ('gather', 'build'):
            self.response_action = {'kind': kind, 'point': local['local_actions'][kind + '_points'][0]}
            result = self.invoke(local=local)
            self.assertEqual(result['action'], {**self.response_action, 'why': 'model'})
            request = self.calls[-1]
            context = json.loads(request['input'][1]['content'])
            self.assertEqual(context['local_actions'], local['local_actions'])
            self.assertNotIn('traveler private memory', json.dumps(request))
            self.assertNotIn('traveler private goal', json.dumps(request))

    def test_invalid_candidates_rejected_before_model_call_without_leak(self):
        valid = {'gather_points': [{'x': 1, 'y': 1, 'z': 0}], 'build_points': []}
        cases = []
        for field, value in (('private', 'traveler private memory'),
                             ('movement', 'traveler private goal'), ('reach', True),
                             ('sensing', 'secret'),
                             ('gather_points', [{'x': 6, 'y': 1, 'z': 0}]),
                             ('gather_points', [{'x': True, 'y': 1, 'z': 0}]),
                             ('gather_points', [{'x': 1, 'y': 1, 'z': 0, 'private': 'secret'}]),
                             ('build_points', [{'x': 0, 'y': 1, 'z': 0}] * (origin_context.MAX_ITEMS + 1))):
            actions = copy.deepcopy(valid); actions[field] = value; cases.append(actions)
        cases.append({'gather_points': []})
        for actions in cases:
            local = copy.deepcopy(self.local); local['local_actions'] = actions
            with self.subTest(actions=actions), self.assertRaises(origin_context.ContextError) as caught:
                self.invoke(local=local)
            self.assertNotIn('secret', str(caught.exception))
            self.assertNotIn('traveler private', str(caught.exception))
        self.assertEqual(self.calls, [])

    def test_resource_response_must_be_in_corresponding_candidates(self):
        local = copy.deepcopy(self.local)
        local['local_actions'] = {'gather_points': [{'x': 1, 'y': 1, 'z': 0}],
                                  'build_points': [{'x': 0, 'y': 1, 'z': 1}]}
        for kind in ('gather', 'build'):
            for point in ({'x': 6, 'y': 1, 'z': 0}, {'x': -1, 'y': 1, 'z': 0},
                          local['local_actions'][('build' if kind == 'gather' else 'gather') + '_points'][0]):
                self.response_action = {'kind': kind, 'point': point}
                with self.subTest(kind=kind, point=point), self.assertRaises(adapter.ModelError) as caught:
                    self.invoke(local=local)
                self.assertEqual(str(caught.exception), 'invalid_action')
                self.assertNotIn('traveler private', repr(caught.exception.audit))
            self.response_action = {'kind': kind, 'point': {'x': 1, 'y': 1, 'z': 0}}
            with self.assertRaises(adapter.ModelError):
                self.invoke()  # No candidates were supplied.
        self.response_action = {'kind': 'wander', 'point': {'x': -1, 'y': 1, 'z': 0}}
        self.assertEqual(self.invoke(local=local)['action']['kind'], 'wander')

    def test_authorization_and_truth_are_explicitly_caller_responsibilities(self):
        doc = origin_context.__doc__.lower()
        self.assertIn('authenticate and authorize', doc)
        self.assertIn('not\nauthentication, authorization', doc)
        self.assertIn('true or suitable', doc)


if __name__ == '__main__':
    unittest.main()
