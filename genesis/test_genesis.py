import copy
import json
import unittest
from genesis.genesis import GenesisError, actor_memories, generate, parse_json, public_view, validate
from genesis.model_adapter import responses_model
from model.adapter import Config


def draft():
    return {'schemaVersion': 1, 'title': '河谷', 'description': '一个河谷',
            'places': [{'id': 'bank', 'name': '岸', 'description': '河岸'}],
            'actors': [{'id': 'a', 'name': '甲', 'role': '旅人', 'goal': '找到住处', 'placeId': 'bank'}],
            'memories': [{'actorId': 'a', 'text': '私人的经历'}], 'rules': [],
            'layout': {'places': [{'placeId': 'bank', 'space': 'outdoor', 'grid': [0, 0]}], 'connections': []}}

class GenesisTests(unittest.TestCase):
    def test_generation_and_private_projection(self):
        seen = []
        def model(system, user):
            seen.append((system, json.loads(user)))
            return json.dumps(draft(), ensure_ascii=False)
        result = generate('安静的河谷', model)
        self.assertEqual(seen[0][1], {'intent': '安静的河谷'})
        self.assertNotIn('私人的经历', json.dumps(public_view(result), ensure_ascii=False))
        self.assertNotIn('goal', public_view(result)['actors'][0])
        public = public_view(result)
        public['actors'][0]['name'] = 'changed'
        self.assertEqual(result['actors'][0]['name'], '甲')
        self.assertEqual(actor_memories(result, 'a'), ['私人的经历'])
        with self.assertRaises(GenesisError): actor_memories(result, 'unknown')

    def test_bad_inputs_fail_closed(self):
        for output in ('{"x":1,"x":2}', '{"x":NaN}', '```json\n{}\n```', 'x'*9000):
            with self.subTest(output=output[:20]), self.assertRaises(GenesisError): parse_json(output)
        for model in (lambda *_: '{}', lambda *_: (_ for _ in ()).throw(RuntimeError('secret'))):
            with self.assertRaises(GenesisError) as e: generate('idea', model)
            self.assertNotIn('secret', str(e.exception))
        with self.assertRaises(GenesisError): generate(' ', lambda *_: '{}')

    def test_invalid_model_draft_is_retried_with_bounded_schema_diagnostics(self):
        invalid = draft()
        invalid['actors'][0]['placeId'] = 'missing'
        seen = []

        def model(system, user):
            seen.append((system, json.loads(user)))
            return json.dumps(invalid if len(seen) == 1 else draft(), ensure_ascii=False)

        self.assertEqual(generate('河谷', model), draft())
        self.assertEqual(len(seen), 2)
        self.assertEqual(seen[0][1], {'intent': '河谷'})
        self.assertEqual(seen[1][1], {
            'intent': '河谷',
            'previous_validation_errors': [{'path': '$.actors[0].placeId', 'code': 'reference'}],
        })
        self.assertIn('Correct the previous output', seen[1][0])

    def test_invalid_model_output_stops_after_three_attempts(self):
        calls = []

        def model(*_):
            calls.append(1)
            return '{}'

        with self.assertRaises(GenesisError) as error:
            generate('idea', model)
        self.assertEqual(error.exception.code, 'invalid_draft')
        self.assertEqual(len(calls), 3)

    def test_references_layout_and_unknown_fields(self):
        d = draft(); d['actors'][0]['placeId'] = 'missing'; d['layout']['places'][0]['grid'] = [True, 0]; d['extra'] = 1
        self.assertTrue(validate(d))
        del d['extra']
        self.assertEqual({e['code'] for e in validate(d)}, {'reference', 'grid'})
        d = draft(); d['layout']['connections'] = [{'from': 'bank', 'to': 'bank'}]
        self.assertIn('reference', {e['code'] for e in validate(d)})
        d = draft(); d['memories'][0]['actorId'] = 'missing'
        self.assertIn('reference', {e['code'] for e in validate(d)})

    def test_existing_transport_without_network(self):
        calls = []
        def transport(config, body):
            calls.append(json.loads(body))
            event = {'type': 'response.completed', 'response': {'status': 'completed', 'output': [{'type':'message','content':[{'type':'output_text','text':json.dumps(draft(), ensure_ascii=False)}]}]}}
            return ('data: ' + json.dumps(event, ensure_ascii=False) + '\n\n').encode()
        model = responses_model(Config('https://example.test/v1', 'test', 'dummy'), transport=transport)
        self.assertEqual(generate('河谷', model), draft())
        self.assertEqual(calls[0]['input'][1]['role'], 'user')
        self.assertTrue(calls[0]['stream'])

if __name__ == '__main__': unittest.main()
