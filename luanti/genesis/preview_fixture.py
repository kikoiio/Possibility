"""Deterministic disposable-preview fixture; its decisions are not model outputs."""
import signal
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'model'))
import spool_worker


def fixture_runner(request, stop, timeout):
    context = request['context']
    obs = context['observation']
    last = (context.get('last_action') or {}).get('kind')
    if obs.get('has_target'):
        action = {'kind': 'advance'}
    elif last != 'say' and obs.get('nearby_agents'):
        action = {'kind': 'say', 'target': min(obs['nearby_agents']), 'text': 'Hello from the preview fixture.'}
    else:
        pos, bounds = obs['pos'], context['bounds']
        x = pos['x'] + (2 if pos['x'] + 2 <= bounds['max']['x'] else -2)
        action = {'kind': 'wander', 'point': {'x': x, 'y': pos['y'], 'z': pos['z']}}
    action['why'] = 'fixture'
    return {'id': request['id'], 'ok': True, 'action': action,
            'audit': {'latency_ms': 0, 'usage': {}}}


def main():
    if len(sys.argv) != 2:
        return 2
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    try:
        spool_worker.serve(sys.argv[1], timeout=45, runner=fixture_runner)
    except KeyboardInterrupt:
        return 0
    return 0

if __name__ == '__main__':
    sys.exit(main())
