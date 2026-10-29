"""Integration of origin, resources and private projections with a fake engine."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

from genesis.origin_confirmation import OriginConfirmation
from genesis.store import DraftStore
from model import adapter, origin_context
from world.origin import draft_sha256
from world.origin_resources import Coordinator
from world.origin_store import create_origin
from world.origin_view import initial_self_context
from world.store import WorldStore


WORLD = '12345678-1234-4234-8234-123456789abc'


class FakeEngine:
    def __init__(self):
        self.identity = WORLD
        self.nodes = {'1,0,0': 'ore'}
        self.inventories = {'traveler': {}, 'alice': {}}

    def get_world_id(self): return self.identity
    def get_node(self, key): return self.nodes[key]
    def set_node(self, key, value): self.nodes[key] = value
    def get_inventory(self, actor): return copy.deepcopy(self.inventories[actor])
    def set_inventory(self, actor, value): self.inventories[actor] = copy.deepcopy(value)


class OriginEndToEndTests(unittest.TestCase):
    def test_confirmed_draft_to_resources_and_retry_after_restart(self):
        draft = json.loads((Path(__file__).parent.parent / 'genesis/example.json').read_text(encoding='utf-8'))
        draft['actors'].append({'id': 'alice', 'name': 'Alice', 'role': 'friend',
                                'goal': 'private goal', 'placeId': 'bank'})
        draft['memories'].append({'actorId': 'alice', 'text': 'Alice remembers a key'})
        engine = FakeEngine()
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
            root = Path(tmp)
            drafts_path, world_path = root / 'drafts.db', root / 'world.db'
            drafts = DraftStore(drafts_path, create=True)
            world = WorldStore(world_path, create=True)
            try:
                draft_id = drafts.create(draft)['id']
                bridge = OriginConfirmation(drafts)
                bridge.confirm(WORLD, 'create', draft_id, 1, str(world_path))
                self.assertEqual(bridge.create(world, engine, WORLD, 'create', draft_id, 1, str(world_path))['version'], 1)
                co = Coordinator(world, engine, world_id=WORLD, exclusive=True)
                co.register('register', {'1,0,0': 'ore'}, {'1,0,0': 'ore'},
                            {'alice': {}, 'traveler': {}})
                co.apply('gather', 2, 'gather', '1,0,0', 'alice')
            finally:
                world.close(); drafts.close()
            world = WorldStore(world_path)
            drafts = DraftStore(drafts_path)
            try:
                bridge = OriginConfirmation(drafts)
                self.assertEqual(bridge.create(world, engine, WORLD, 'create', draft_id, 1,
                                               str(world_path), exclusive=True)['version'], 1)
                self.assertEqual(world.recover()['version'], 3)
                event = world.recover()['events'][0]['event']
                self.assertEqual(initial_self_context(event, WORLD, 'alice')['memories'][0]['text'],
                                 'Alice remembers a key')
                self.assertEqual(engine.inventories['alice'], {'ore': 1})
                calls = []
                def transport(config, body):
                    calls.append(json.loads(body))
                    return (b'data: {"type":"response.output_text.delta","delta":"{\\"kind\\":\\"inspect\\"}"}\n\n'
                            b'data: {"type":"response.completed","response":{"status":"completed"}}\n\n')
                saved = event['data']['origin']['runtime_ids']
                binding = {'contract_version': 1, 'world_id': WORLD, 'origin_event_id': event['id'],
                           'draft_sha256': event['data']['draft_sha256'], 'actor_id': 'alice',
                           'runtime_ids': saved, 'luanti_id': saved['alice'] - 1}
                local = {'observation': {'has_target': False, 'nearby_agents': [saved['traveler'] - 1]},
                         'bounds': {'min': {'x': -2, 'y': 0, 'z': -2}, 'max': {'x': 2, 'y': 2, 'z': 2}},
                         'incoming_messages': [], 'feedback': []}
                config = adapter.Config('https://example.invalid/v1', 'fixture', 'key')
                origin_context.decide(config, event, binding, local, transport=transport)
                sent = json.loads(calls[0]['input'][1]['content'])
                self.assertEqual(sent['self']['memories'][0]['text'], 'Alice remembers a key')
                self.assertNotIn(draft['memories'][0]['text'], json.dumps(sent, ensure_ascii=False))
            finally:
                world.close(); drafts.close()

    def test_origin_resources_restart_and_separate_private_context(self):
        draft = json.loads((Path(__file__).parent.parent / 'genesis/example.json').read_text(encoding='utf-8'))
        draft['actors'].append({'id': 'alice', 'name': 'Alice', 'role': 'friend',
                                'goal': 'private goal', 'placeId': 'bank'})
        draft['memories'] = [{'actorId': 'alice', 'text': 'Alice remembers a key'},
                             {'actorId': 'traveler', 'text': 'Traveler remembers a map'}]
        confirmed = {'draft_id': 'draft', 'draft_revision': 1,
                     'draft_sha256': draft_sha256(draft), 'operation_id': 'create',
                     'status': 'confirmed', 'draft': draft}
        engine = FakeEngine()
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as tmp:
            path = Path(tmp) / 'world.sqlite'
            store = WorldStore(path, create=True)
            try:
                self.assertEqual(create_origin(store, engine, WORLD, 'create', confirmed)['version'], 1)
                coordinator = Coordinator(store, engine, world_id=WORLD, exclusive=True)
                coordinator.register('register', {'1,0,0': 'ore'}, {'1,0,0': 'ore'},
                                     {'alice': {}, 'traveler': {}})
                coordinator.apply('gather', 2, 'gather', '1,0,0', 'alice')
                before = store.recover()
            finally:
                store.close()

            # A persisted projection can lag a committed world after interruption.
            engine.nodes['1,0,0'] = 'ore'
            engine.inventories['alice'] = {}
            store = WorldStore(path)
            try:
                coordinator = Coordinator(store, engine, world_id=WORLD, exclusive=True)
                self.assertEqual(coordinator.reconcile(), {'phase': 'READY', 'version': 3})
                self.assertEqual(engine.nodes['1,0,0'], 'air')
                self.assertEqual(engine.inventories['alice'], {'ore': 1})
                after = store.recover()
                self.assertEqual(before, after)
                origin = after['events'][0]['event']
                alice = initial_self_context(origin, WORLD, 'alice')
                traveler = initial_self_context(origin, WORLD, 'traveler')
                self.assertEqual(alice['memories'][0]['text'], 'Alice remembers a key')
                self.assertEqual(traveler['memories'][0]['text'], 'Traveler remembers a map')
                self.assertNotIn('Traveler remembers a map', repr(alice))
                self.assertNotIn('Alice remembers a key', repr(traveler))
                self.assertEqual(coordinator.apply('gather', 2, 'gather', '1,0,0', 'alice')['version'], 3)
                self.assertEqual(create_origin(store, engine, WORLD, 'create', confirmed, exclusive=True)['version'], 1)
                self.assertEqual(store.recover()['version'], 3)
            finally:
                store.close()


if __name__ == '__main__':
    unittest.main()
