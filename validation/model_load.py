#!/usr/bin/env python3
"""Measure action-generation load by replaying private audited product requests.

This does not run a world, advance live actors, or persist memories. Real runs
belong on authorized cloud resources. The runner injection supports offline tests.
--output creates a private directory containing calls.jsonl and summary.json.
"""
from __future__ import annotations

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from copy import deepcopy
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys
from threading import Lock
import time
import uuid

if __package__ in (None, ''):  # direct script execution from any working directory
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from model import adapter
from model.product_envelope import validate as validate_envelope

MAX_CALLS = 2048
MAX_CONCURRENCY = 16
MAX_AUDIT_BYTES = adapter.MAX_REQUEST * 2
TOKEN_FIELDS = ('input_tokens', 'output_tokens', 'total_tokens')
SAFE_ERRORS = frozenset({
    'invalid_config', 'invalid_context', 'request_too_large', 'transport_error',
    'invalid_content_type', 'response_too_large', 'output_too_large',
    'invalid_response', 'provider_failed', 'incomplete_response', 'invalid_action',
    'rate_limited', 'timeout',
})


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError('invalid_audit')
        result[key] = value
    return result


def load_inputs(audit_dir, *, limit=MAX_CALLS):
    """Read at most limit bounded request files, validating before any calls."""
    root = Path(audit_dir)
    if not root.is_dir() or type(limit) is not int or not 1 <= limit <= MAX_CALLS:
        raise ValueError('invalid_audit')
    samples = []
    for directory, dirs, names in os.walk(root, followlinks=False):
        dirs.sort()
        for name in sorted(names):
            if not name.startswith('request-') or not name.endswith('.json'):
                continue
            path = Path(directory) / name
            try:
                if path.is_symlink():
                    raise ValueError
                with path.open('rb') as source:
                    raw = source.read(MAX_AUDIT_BYTES + 1)
                if len(raw) > MAX_AUDIT_BYTES:
                    raise ValueError
                request = json.loads(raw, object_pairs_hook=_pairs)
                if (type(request) is not dict or set(request) != {'id', 'context'} or
                        type(request['id']) is not int or not 0 <= request['id'] <= 2**53 - 1 or
                        type(request['context']) is not dict):
                    raise ValueError
                context = {key: value for key, value in request['context'].items()
                           if key != 'reflection_input'}
                validate_envelope(context.get('model_input'))
                # These fields stay local to the adapter's action validation.
                adapter._normalize_context(context)
                json.dumps(context, allow_nan=False)
            except (OSError, ValueError, TypeError, RecursionError, adapter.ModelError):
                raise ValueError('invalid_audit') from None
            samples.append({'source': str(path.relative_to(root)),
                            'source_sha256': hashlib.sha256(raw).hexdigest(),
                            'context': context})
            if len(samples) == limit:
                return samples
    if not samples:
        raise ValueError('invalid_audit')
    return samples


def _audit(value):
    """Keep only the adapter's numeric usage/timing and digest audit fields."""
    if type(value) is not dict:
        return {}
    result = {}
    for key in ('context_sha256', 'prompt_sha256'):
        if isinstance(value.get(key), str) and re.fullmatch(r'[0-9a-f]{64}', value[key]):
            result[key] = value[key]
    latency = value.get('latency_ms')
    if type(latency) in (int, float) and 0 <= latency <= 10**12 and math.isfinite(latency):
        result['latency_ms'] = latency
    usage = value.get('usage')
    if type(usage) is dict:
        safe = {key: usage[key] for key in TOKEN_FIELDS
                if type(usage.get(key)) is int and 0 <= usage[key] <= 10**9}
        if usage.get('invalid') is True or any(key in usage and key not in safe for key in TOKEN_FIELDS):
            safe['invalid'] = True
        result['usage'] = safe
    return result


def _redact(value, secrets):
    if isinstance(value, str):
        for secret in secrets:
            value = value.replace(secret, '[redacted]')
        return value
    if isinstance(value, dict):
        return {_redact(key, secrets): _redact(item, secrets) for key, item in value.items()}
    if isinstance(value, list):
        return [_redact(item, secrets) for item in value]
    return value


def _percentiles(values):
    values = sorted(values)
    return {'samples': len(values),
            'p50': values[math.ceil(.50 * len(values)) - 1] if values else None,
            'p95': values[math.ceil(.95 * len(values)) - 1] if values else None}


def _private_file(path):
    return os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600),
                     'w', encoding='utf-8')


def run(audit_dir, output, *, calls=128, concurrency=4, config=None, runner=None,
        clock=time.monotonic):
    """Replay snapshots with bounded concurrency; stream one record per call.

    runner(config, context) defaults to adapter.decide. Each call gets a detached
    context, a unique decision ID, and its original actor-private knowledge.
    There are no retries: errors count toward the requested number of calls.
    """
    if (type(calls) is not int or not 1 <= calls <= MAX_CALLS or
            type(concurrency) is not int or not 1 <= concurrency <= MAX_CONCURRENCY):
        raise ValueError('invalid_load_configuration')
    samples = load_inputs(audit_dir, limit=calls)
    config = adapter.Config.from_env() if config is None else config
    runner_kind = 'provider' if runner is None else 'injected'
    runner = adapter.decide if runner is None else runner
    secrets = sorted({value for value in (getattr(config, 'api_key', None),
                                          getattr(config, 'base_url', None))
                      if isinstance(value, str) and value}, key=len, reverse=True)
    run_id = uuid.uuid4().hex
    # Changing the decision ID can increase the envelope size. Preflight that
    # change for every selected snapshot before submitting any provider work.
    for sample in samples:
        envelope = deepcopy(sample['context']['model_input'])
        envelope['request']['decision_id'] = f'model-load:{run_id}:{calls - 1}'
        validate_envelope(envelope)
    output = Path(output)
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    active = active_max = 0
    lock = Lock()

    def invoke(index, sample, queued_at):
        nonlocal active, active_max
        dequeued_at = clock()
        context = deepcopy(sample['context'])
        request = context['model_input']['request']
        original_id = request['decision_id']
        request['decision_id'] = f'model-load:{run_id}:{index}'
        validate_envelope(context['model_input'])
        row = {'sample': index, 'source': sample['source'],
               'source_sha256': sample['source_sha256'],
               'source_decision_id': original_id, 'decision_id': request['decision_id'],
               'actor_id': request['actor_id'], 'world_id': request['world_id'],
               'ok': False, 'error': None, 'audit': {}, 'result': None,
               'queue_wait_ms': max(0, (dequeued_at - queued_at) * 1000)}
        with lock:
            active += 1
            active_max = max(active_max, active)
        started = clock()
        try:
            result = runner(config, context)
            if (type(result) is not dict or type(result.get('action')) is not dict or
                    not isinstance(result['action'].get('kind'), str)):
                raise adapter.ModelError('invalid_response')
            audit = _audit(result.get('audit'))
            result = _redact({**result, 'audit': audit}, secrets)
            json.dumps(result, allow_nan=False)
            row.update(ok=True, result=result, audit=audit)
        except adapter.ModelError as exc:
            row.update(error=str(exc) if str(exc) in SAFE_ERRORS else 'internal_error',
                       audit=_audit(exc.audit))
        except TimeoutError:
            row['error'] = 'timeout'
        except Exception:
            row['error'] = 'internal_error'
        finally:
            row['latency_ms'] = max(0, (clock() - started) * 1000)
            with lock:
                active -= 1
        return _redact(row, secrets)

    latencies, waits = [], []
    errors = Counter()
    token_totals = Counter()
    token_reports = Counter()
    invalid_usage = successes = 0
    started = clock()
    with _private_file(output / 'calls.jsonl') as stream:
        with ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix='model-load') as executor:
            futures = [executor.submit(invoke, index, samples[index % len(samples)], clock())
                       for index in range(calls)]
            try:
                for future in as_completed(futures):
                    row = future.result()
                    stream.write(json.dumps(row, ensure_ascii=True, allow_nan=False) + '\n')
                    stream.flush()
                    latencies.append(row['latency_ms'])
                    waits.append(row['queue_wait_ms'])
                    successes += row['ok']
                    if not row['ok']:
                        errors[row['error']] += 1
                    usage = row['audit'].get('usage', {})
                    invalid_usage += usage.get('invalid') is True
                    for key in TOKEN_FIELDS:
                        if key in usage:
                            token_totals[key] += usage[key]
                            token_reports[key] += 1
            except BaseException:
                for future in futures:
                    future.cancel()
                raise
    elapsed = max(0, clock() - started)
    actors = {(sample['context']['model_input']['request']['world_id'],
               sample['context']['model_input']['actor']['id']) for sample in samples}
    summary = {
        'schema': 'wispiva.model-load', 'version': 1, 'run_id': run_id,
        'mode': 'audit_replay', 'action_generation_only': True, 'runner': runner_kind,
        'live_actor_count': 0, 'replayed_actor_count': len(actors),
        'interpretation': 'Fixed audited contexts; no live world, actor advancement, or memory persistence.',
        'source_samples': len(samples), 'calls': calls, 'concurrency': concurrency,
        'completed_calls': len(latencies), 'successful_calls': successes,
        'failed_calls': calls - successes, 'active_max': active_max,
        'elapsed_s': elapsed, 'throughput_calls_per_s': calls / elapsed if elapsed else None,
        'successful_actions_per_s': successes / elapsed if elapsed else None,
        'latency_ms': _percentiles(latencies), 'queue_wait_ms': _percentiles(waits),
        'errors': dict(sorted(errors.items())),
        'token_totals': {key: token_totals[key] if token_reports[key] else None for key in TOKEN_FIELDS},
        'token_reported_calls': {key: token_reports[key] for key in TOKEN_FIELDS},
        'token_totals_complete': not invalid_usage and all(token_reports[key] == calls for key in TOKEN_FIELDS),
        'invalid_usage_calls': invalid_usage,
    }
    with _private_file(output / 'summary.json') as stream:
        json.dump(summary, stream, ensure_ascii=True, indent=2, allow_nan=False)
        stream.write('\n')
    return summary


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--audit-dir', required=True)
    parser.add_argument('--calls', type=int, default=128, help='1..2048 (default: 128)')
    parser.add_argument('--concurrency', type=int, default=4, help='1..16 (default: 4)')
    parser.add_argument('--output', required=True, help='new private output directory')
    args = parser.parse_args(argv)
    try:
        summary = run(args.audit_dir, args.output, calls=args.calls, concurrency=args.concurrency)
    except (OSError, ValueError):
        print('model load configuration or input/output failure', file=sys.stderr)
        return 2
    return 0 if summary['failed_calls'] == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
