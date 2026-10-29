import copy
import json
from pathlib import Path
import unittest

from world.origin import OriginError, create_origin_event, draft_sha256
from world.origin_view import initial_self_context

WORLD = '12345678-1234-4234-8234-123456789abc'


class InitialSelfContextTests(unittest.TestCase):
    def setUp(self):
        draft = json.loads((Path(__file__).parent.parent / 'genesis/example.json').read_text(encoding='utf-8'))
        draft['actors'].append({'id': 'alice', 'name': '爱丽丝', 'role': '朋友',
                                'goal': '寻找河流', 'placeId': 'bank'})
        draft['memories'] = [{'actorId': 'traveler', 'text': '旅人秘密'},
                             {'actorId': 'alice', 'text': '第一条'},
                             {'actorId': 'traveler', 'text': '另一秘密'},
                             {'actorId': 'alice', 'text': '第二条'}]
        self.confirmed = {'draft_id': 'draft-1', 'draft_revision': 2,
                          'draft_sha256': draft_sha256(draft), 'operation_id': 'create-1',
                          'status': 'confirmed', 'draft': draft}
        self.event = create_origin_event(WORLD, self.confirmed)

    def test_private_memories_and_goals_do_not_cross_actors(self):
        alice = initial_self_context(self.event, WORLD, 'alice')
        traveler = initial_self_context(self.event, WORLD, 'traveler')
        self.assertEqual([m['text'] for m in alice['memories']], ['第一条', '第二条'])
        self.assertEqual([m['text'] for m in traveler['memories']], ['旅人秘密', '另一秘密'])
        self.assertNotIn('旅人秘密', repr(alice))
        self.assertNotIn(traveler['goal'], repr(alice))
        self.assertNotIn('第一条', repr(traveler))
        self.assertEqual(alice['memories'][0]['source']['event_id'], self.event['id'])
        self.assertNotIn('origin', alice)
        self.assertNotIn('rules', alice)

    def test_rejects_unknown_identity_and_invalid_origin(self):
        with self.assertRaises(OriginError):
            initial_self_context(self.event, WORLD, 'stranger')
        altered = copy.deepcopy(self.event)
        altered['data']['origin']['draft']['memories'][0]['text'] = 'tampered'
        with self.assertRaises(OriginError):
            initial_self_context(altered, WORLD, 'alice')
        with self.assertRaises(OriginError):
            initial_self_context(self.event, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'alice')

    def test_output_is_detached_from_origin(self):
        first = initial_self_context(self.event, WORLD, 'alice')
        first['memories'][0]['source']['kind'] = 'changed'
        second = initial_self_context(self.event, WORLD, 'alice')
        self.assertEqual(second['memories'][0]['source']['kind'], 'genesis.seed')


if __name__ == '__main__':
    unittest.main()
