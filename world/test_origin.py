import copy
import hashlib
import json
from pathlib import Path
import unittest

from world.origin import OriginError, create_origin_event, draft_sha256, origin_snapshot, validate_world_id


WORLD = '12345678-1234-4234-8234-123456789abc'


class OriginTests(unittest.TestCase):
    def setUp(self):
        self.draft = json.loads((Path(__file__).parent.parent / 'genesis/example.json').read_text(encoding='utf-8'))
        self.draft['actors'].append({'id': 'alice', 'name': '爱丽丝', 'role': '朋友',
                                     'goal': '寻找河流', 'placeId': 'bank'})
        self.draft['memories'] = [{'actorId': 'traveler', 'text': '旅人秘密'},
                                  {'actorId': 'alice', 'text': '第一条'},
                                  {'actorId': 'traveler', 'text': '另一秘密'},
                                  {'actorId': 'alice', 'text': '第二条'}]
        self.draft['rules'] = [{'id': 'rule', 'description': '描述性规则'}]
        self.confirmed = {'draft_id': 'draft-1', 'draft_revision': 2,
                          'draft_sha256': draft_sha256(self.draft), 'operation_id': 'create-1',
                          'status': 'confirmed', 'draft': self.draft}

    def test_event_snapshot_and_private_seeds(self):
        event = create_origin_event(WORLD, self.confirmed)
        world, characters = origin_snapshot(event, WORLD)
        self.assertEqual(event['data']['origin']['draft'], self.draft)
        self.assertEqual(event['data']['origin']['runtime_ids'], {'alice': 1, 'traveler': 2})
        self.assertEqual(world['origin'], event['data']['origin'])
        self.assertIsNone(world['resources'])
        self.assertEqual(characters['alice']['memory_seeds'], [
            {'seed_id': 'create-1:seed:alice:0', 'text': '第一条',
             'source': {'event_id': 'create-1', 'kind': 'genesis.seed'}},
            {'seed_id': 'create-1:seed:alice:1', 'text': '第二条',
             'source': {'event_id': 'create-1', 'kind': 'genesis.seed'}}])
        self.assertEqual([s['text'] for s in characters['traveler']['memory_seeds']], ['旅人秘密', '另一秘密'])
        self.assertNotIn('旅人秘密', json.dumps(characters['alice'], ensure_ascii=False))
        self.assertNotIn('第一条', json.dumps(characters['traveler'], ensure_ascii=False))
        self.assertIsNone(characters['alice']['inventory'])
        self.assertEqual(characters['alice']['place_id'], 'bank')

    def test_determinism_and_detached_values(self):
        event = create_origin_event(WORLD, self.confirmed)
        self.assertEqual(event, create_origin_event(WORLD, copy.deepcopy(self.confirmed)))
        self.assertEqual(origin_snapshot(event, WORLD), origin_snapshot(copy.deepcopy(event), WORLD))
        reversed_ref = copy.deepcopy(self.confirmed)
        reversed_ref['draft']['actors'].reverse()
        reversed_ref['draft_sha256'] = draft_sha256(reversed_ref['draft'])
        self.assertEqual(create_origin_event(WORLD, reversed_ref)['data']['origin']['runtime_ids'],
                         event['data']['origin']['runtime_ids'])
        world, characters = origin_snapshot(event, WORLD)
        world['origin']['draft']['title'] = 'changed'
        characters['alice']['memory_seeds'][0]['source']['kind'] = 'changed'
        self.assertEqual(event['data']['origin']['draft'], self.draft)
        self.draft['title'] = 'caller mutation'
        self.assertNotEqual(event['data']['origin']['draft']['title'], self.draft['title'])

    def test_digest_encoding(self):
        encoded = json.dumps(self.draft, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)
        self.assertEqual(draft_sha256(self.draft), hashlib.sha256(encoded.encode('utf-8')).hexdigest())

    def test_invalid_world_ids(self):
        for value in (None, '', WORLD.upper(), '{' + WORLD + '}', WORLD.replace('-', ''), 'not-uuid'):
            with self.subTest(value=value), self.assertRaises(OriginError):
                validate_world_id(value)

    def test_invalid_confirmation_and_drafts(self):
        cases = []
        for key, value in [('status', 'pending'), ('draft_revision', True), ('draft_revision', 0),
                           ('draft_id', ''), ('operation_id', ''), ('operation_id', '\ud800'),
                           ('draft_sha256', '0' * 64)]:
            ref = copy.deepcopy(self.confirmed); ref[key] = value; cases.append(ref)
        ref = copy.deepcopy(self.confirmed); ref['extra'] = 1; cases.append(ref)
        for change in ('no_actors', 'duplicate', 'bad_place', 'bad_memory', 'version', 'unknown', 'surrogate'):
            ref = copy.deepcopy(self.confirmed); draft = ref['draft']
            if change == 'no_actors': draft['actors'] = []
            elif change == 'duplicate': draft['actors'][1]['id'] = draft['actors'][0]['id']
            elif change == 'bad_place': draft['actors'][0]['placeId'] = 'missing'
            elif change == 'bad_memory': draft['memories'][0]['actorId'] = 'missing'
            elif change == 'version': draft['schemaVersion'] = 2
            elif change == 'unknown': draft['unexpected'] = 1
            else: draft['title'] = '\ud800'
            cases.append(ref)
        for ref in cases:
            with self.subTest(ref=repr(ref)), self.assertRaises(OriginError):
                create_origin_event(WORLD, ref)

    def test_replay_rejects_tampering(self):
        event = create_origin_event(WORLD, self.confirmed)
        cases = []
        for key, value in [('contract_version', True), ('contract_version', 2),
                           ('world_id', 'another'), ('draft_revision', 0),
                           ('draft_sha256', 'A' * 64)]:
            e = copy.deepcopy(event); e['data'][key] = value; cases.append(e)
        for key, value in [('runtime_ids', {'alice': 1, 'traveler': 1}),
                           ('runtime_ids', {'alice': True, 'traveler': 2}),
                           ('runtime_ids', {'alice': 1}),
                           ('runtime_ids', {'alice': 1, 'traveler': 3}),
                           ('coordinate_system', 'unknown')]:
            e = copy.deepcopy(event); e['data']['origin'][key] = value; cases.append(e)
        e = copy.deepcopy(event); e['data']['origin']['draft']['title'] = 'tampered'; cases.append(e)
        e = copy.deepcopy(event); e['data']['unexpected'] = 1; cases.append(e)
        e = copy.deepcopy(event); e['type'] = 'other'; cases.append(e)
        for e in cases:
            with self.subTest(event=repr(e)), self.assertRaises(OriginError):
                origin_snapshot(e, WORLD)
        with self.assertRaises(OriginError):
            origin_snapshot(event, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')

    def test_replay_uses_persisted_bijection(self):
        event = create_origin_event(WORLD, self.confirmed)
        event['data']['origin']['runtime_ids'] = {'alice': 2, 'traveler': 1}
        _, characters = origin_snapshot(event, WORLD)
        self.assertEqual(characters['alice']['runtime_id'], 2)
        self.assertEqual(characters['traveler']['runtime_id'], 1)


if __name__ == '__main__':
    unittest.main()
