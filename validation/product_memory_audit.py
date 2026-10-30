"""Audit live product L2 writeback, private retrieval and restart continuity."""
import argparse
import json
from pathlib import Path

from model.product_envelope import validate


def checkpoint(world):
    storage = json.loads((Path(world) / 'mod_storage/society').read_text())
    return json.loads(storage['agent_state'])


def audit(world, before=None):
    world = Path(world)
    saved = checkpoint(world)
    manifest = json.loads((world / 'private/wispiva-origin.json').read_text())
    public = manifest['public']
    expected_world_text = 'World: ' + public['title']
    if public.get('description'):
        expected_world_text += '. ' + public['description']
    records = {row['id']: row for row in saved['long_term']['records']}
    beliefs = {key: row for key, row in records.items() if row['layer'] == 'L2'}
    assert beliefs, 'no durable L2 records'
    requests = sorted((world / 'private/model-audit').rglob('request-*.json'))
    actor_owners, applied, used, runs = {}, set(), set(), {}
    reflection_calls = 0
    tokens = {'input_tokens': 0, 'output_tokens': 0, 'total_tokens': 0}
    for path in requests:
        request = json.loads(path.read_text())
        context = request['context']
        envelope = context['model_input']
        validate(envelope)
        actor = envelope['actor']['id']
        public_genesis = [row for row in envelope['knowledge']['facts']
                          if row['source']['kind'] == 'genesis.public']
        assert len(public_genesis) == 1, 'missing shared public world context'
        assert public_genesis[0]['source']['id'] == envelope['request']['origin_event_id']
        assert public_genesis[0]['text'] == expected_world_text
        assert public_genesis[0]['access'] == {'scope': 'public', 'audience': [actor]}
        owner = str(int(envelope['actor']['runtime_id']))
        actor_owners[actor] = owner
        runs.setdefault(path.parent.name, []).append(envelope)
        response = json.loads(path.with_name(path.name.replace('request-', 'response-', 1)).read_text())
        assert response['ok'], response
        assert response['id'] == request['id']
        for attempt in response.get('attempts', [response]):
            for field in ('audit', 'reflection_audit'):
                for key in tokens:
                    tokens[key] += ((attempt.get(field) or {}).get('usage') or {}).get(key, 0)
        selected = context.get('reflection_input')
        if selected:
            reflection_calls += 1
            assert selected['request']['actor_id'] == actor
            assert selected['request']['world_id'] == envelope['request']['world_id']
            for row in selected['experiences']:
                durable = records[row['id']]
                assert durable['layer'] == 'L1' and durable['owner'] == owner
                assert durable['classification'] in ('experience', 'rumor')
                assert row['audience'] == [actor] and durable['text'] == row['text']
            proposal = response['reflection']
            cited = proposal['source_ids']
            assert cited and len(set(cited)) == len(cited)
            assert set(cited) <= {r['id'] for r in selected['experiences']}
            producer = path.parent.name + ':request:' + str(request['id'])
            matches = [r for r in beliefs.values() if r['source']['id'] == producer and r['owner'] == owner]
            assert len(matches) == 1, ('missing or duplicate writeback', producer)
            belief = matches[0]
            assert belief['text'] == proposal['text'] and belief['topic'] == proposal['topic']
            assert belief['experiences'] == cited
            applied.add(belief['id'])
        else:
            assert 'reflection' not in response
        for row in envelope['knowledge'].get('reflections') or []:
            belief = beliefs[row['id']]
            assert belief['owner'] == owner and row['access']['audience'] == [actor]
            assert row['epistemic'] == 'belief' and row['text'] == belief['text']
            assert row['source']['revision'] == belief['version']
            used.add(row['id'])
    assert applied == set(beliefs), 'unexplained durable reflection'
    assert used, 'no subsequent decision retrieved a reflection'
    versions = {}
    for row in beliefs.values():
        versions.setdefault((row['owner'], row['topic']), []).append(int(row['version']))
    for values in versions.values():
        assert sorted(values) == list(range(1, max(values) + 1)), values
    assert {records[key]['owner'] for key in used} == set(actor_owners.values()), 'not all roles used L2'
    restored = 0
    if before is not None:
        old = json.loads(Path(before).read_text())
        old_records = {r['id']: r for r in old['long_term']['records']}
        assert all(records[key] == value for key, value in old_records.items()), 'restart altered history'
        old_ids = {key for key, r in old_records.items() if r['layer'] == 'L2'}
        new_runs = [rows for rows in runs.values()
                    if any(int(e['feedback'].get('world_revision', 0)) > 0 for e in rows)
                    and any(any(r['id'] in old_ids for r in e['knowledge'].get('reflections') or []) for e in rows)]
        assert new_runs, 'no restored reflection appeared in provider input'
        old_agents = {str(int(a['id'])): a for a in old['agents']}
        for owner, agent in old_agents.items():
            rows = [e for group in new_runs for e in group if str(int(e['actor']['runtime_id'])) == owner]
            # First request whose decision counter follows the old checkpoint.
            later = [e for e in rows if int(e['request']['decision_id'].rsplit(':', 1)[-1]) == int(agent['decisions']) + 1]
            assert len(later) == 1, ('missing first resumed input', owner)
            e = later[0]
            assert any(r['id'] in old_ids for r in e['knowledge'].get('reflections') or [])
            assert e['feedback']['event_id'] == agent['last_action']['event_id'], 'lost action feedback'
            restored += 1
    return {'requests': len(requests), 'reflection_calls': reflection_calls,
            'durable_beliefs': len(beliefs), 'retrieved_beliefs': len(used),
            'actors': sorted(actor_owners), 'resumed_actors': restored,
            'runs': sorted(runs), 'usage': tokens}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--world', type=Path, required=True)
    parser.add_argument('--before', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--save-checkpoint', type=Path)
    args = parser.parse_args()
    result = audit(args.world, args.before)
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    if args.save_checkpoint:
        args.save_checkpoint.write_text(json.dumps(checkpoint(args.world)))
    print(json.dumps(result))


if __name__ == '__main__':
    main()
