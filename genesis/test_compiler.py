import copy
import json
import unittest

from genesis.compiler import CompileError, compile_plan, public_plan
from genesis.test_genesis import draft


def with_actors(count):
    d = draft()
    d['actors'] = [{'id': f'person{i}', 'name': f'Name{i}', 'role': f'Role{i}',
                    'goal': f'Goal{i}', 'placeId': 'bank'} for i in range(count)]
    d['memories'] = [{'actorId': f'person{i}', 'text': f'Secret{i}'} for i in range(count)]
    return d


class CompilerTests(unittest.TestCase):
    def test_product_population_and_private_projection(self):
        for count in (1, 5, 6, 25):
            with self.subTest(count=count):
                d = with_actors(count)
                plan = compile_plan(d)
                self.assertEqual(plan['public']['title'], d['title'])
                self.assertEqual(plan['public']['description'], d['description'])
                self.assertEqual(len(plan['public']['actors']), count)
                self.assertEqual([a['ordinal'] for a in plan['public']['actors']], list(range(count)))
                points = [tuple(a['position'].values()) for a in plan['public']['actors']]
                self.assertEqual(len(points), len(set(points)))
                for i in range(count):
                    a = plan['private_actors'][f'person{i}']
                    self.assertEqual(a, {'role': f'Role{i}', 'goal': f'Goal{i}', 'memory_seeds': [f'Secret{i}']})
                    self.assertNotIn(f'Secret{i}', json.dumps(public_plan(plan)))
                    self.assertNotIn(f'Goal{i}', json.dumps(public_plan(plan)))
                json.dumps(plan, allow_nan=False)
                public_plan(plan)['actors'][0]['name'] = 'changed'
                self.assertNotEqual(plan['public']['actors'][0]['name'], 'changed')
                self.assertEqual(d, with_actors(count))
        d = with_actors(64)
        d['places'].extend([
            {'id': 'hill', 'name': 'Hill', 'description': 'Hill'},
            {'id': 'camp', 'name': 'Camp', 'description': 'Camp'},
        ])
        d['layout']['places'].extend([
            {'placeId': 'hill', 'space': 'outdoor', 'grid': [1, 0]},
            {'placeId': 'camp', 'space': 'outdoor', 'grid': [-1, 0]},
        ])
        for i, actor in enumerate(d['actors']):
            actor['placeId'] = ('bank', 'hill', 'camp')[i % 3]
        plan = compile_plan(d)
        self.assertEqual(len(plan['public']['actors']), 64)

    def test_reordering_and_canonical_semantic_edges(self):
        d = with_actors(3)
        d['places'].append({'id': 'hill', 'name': 'Hill', 'description': 'Hill'})
        d['layout']['places'].append({'placeId': 'hill', 'space': 'indoor', 'grid': [1, -1]})
        d['layout']['connections'] = [{'from': 'hill', 'to': 'bank'}]
        before = compile_plan(d)
        d['actors'].reverse(); d['places'].reverse(); d['layout']['places'].reverse()
        d['layout']['connections'][0] = {'from': 'bank', 'to': 'hill'}
        self.assertEqual(before, compile_plan(d))
        self.assertEqual(before['public']['semantic_connections'], [{'from': 'bank', 'to': 'hill'}])

    def test_bad_count_invalid_ids_and_conflicts(self):
        for count in (0,):
            with self.subTest(count=count), self.assertRaises(CompileError) as e: compile_plan(with_actors(count))
            self.assertEqual(e.exception.code, 'actor_count')
        with self.assertRaises(CompileError) as e: compile_plan(with_actors(65))
        self.assertEqual(e.exception.code, 'invalid_draft')
        d = with_actors(2); d['actors'][1]['id'] = d['actors'][0]['id']
        with self.assertRaises(CompileError): compile_plan(d)
        d = with_actors(1); d['actors'][0]['id'] = '../escape'
        with self.assertRaises(CompileError): compile_plan(d)
        d = with_actors(1); d['places'].append({'id': 'other', 'name': 'Other', 'description': 'Other'})
        d['layout']['places'].append({'placeId': 'other', 'space': 'outdoor', 'grid': [0, 0]})
        with self.assertRaises(CompileError): compile_plan(d)

    def test_bounds_for_places_and_spawn_offsets(self):
        d = with_actors(1); d['layout']['places'][0]['grid'] = [5, 0]
        with self.assertRaises(CompileError) as e: compile_plan(d)
        self.assertEqual(e.exception.code, 'out_of_bounds')
        d = with_actors(25); d['layout']['places'][0]['grid'] = [4, 0]
        with self.assertRaises(CompileError) as e: compile_plan(d)
        self.assertEqual(e.exception.diagnostics[0]['code'], 'spawn_out_of_bounds')
        d = with_actors(26)
        with self.assertRaises(CompileError) as e: compile_plan(d)
        self.assertEqual(e.exception.code, 'place_actor_capacity')
        d = with_actors(1); d['layout']['places'][0]['grid'] = [-3, 3]
        self.assertEqual(compile_plan(d)['public']['actors'][0]['position'], {'x': -26, 'y': 1, 'z': 22})

    def test_rules_are_reported_not_executed(self):
        d = with_actors(1); d['rules'] = [{'id': 'rule', 'description': 'Never reveal this secret'}]
        plan = compile_plan(d)
        self.assertIn({'code': 'descriptive_rule_not_executed', 'rule_id': 'rule'}, plan['unsupported'])
        self.assertNotIn('Never reveal this secret', json.dumps(plan))
        self.assertIn({'code': 'semantic_connections_not_paths'}, plan['unsupported'])

if __name__ == '__main__': unittest.main()
