"""Paired Lua-memory tasks through adapter.decide; sanitized, bounded evidence.

Default: 4 tasks x 3 seeds x 2 arms = 24 model calls, without retries.
--fixture is a synthetic protocol/scorer check, never model-quality evidence.
--probe (alias --concurrency-probe 1 2 4) uses 8 fixed calls per level.
All model calls run in disposable children with a hard deadline. Real execution
belongs on authorized cloud CI; this module does not provision cloud resources.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import ctypes
import ctypes.util
from dataclasses import dataclass, field, replace
import hashlib
import json
import math
from pathlib import Path
import random
import re
import shutil
import subprocess
import sys
import time

import adapter

ROOT = Path(__file__).resolve().parents[1]
HARD_CALL_LIMIT = 48
PROBE_REQUESTS = 8
SCORE_CATEGORIES = ('correct', 'abstained', 'wrong_source_target', 'stale_fact_used',
                    'known_failure_repeated', 'wrong_target', 'wrong_action',
                    'wrong_answer', 'unscored')
SCORE_FLAGS = ('abstained', 'wrong_source_target', 'stale_fact_used',
               'known_failure_repeated', 'wrong_target', 'wrong_action')
SAFE_ERRORS = frozenset({
    'invalid_config', 'invalid_context', 'request_too_large', 'transport_error',
    'invalid_content_type', 'response_too_large', 'output_too_large',
    'invalid_response', 'incomplete_response', 'provider_failed', 'invalid_action',
    'deadline_exceeded', 'worker_failed', 'unexpected_error', 'rate_limited',
})


class EvaluationError(Exception):
    """Only fixed diagnostic codes may escape into evidence or stderr."""


def compact(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True,
                      separators=(',', ':'), allow_nan=False)


def digest(value):
    return hashlib.sha256(compact(value).encode()).hexdigest()


def _lua_quote(value):
    # Decimal byte escapes work in Lua 5.1 and cannot inject code via a path.
    return '"' + ''.join('\\%03d' % byte for byte in value.encode()) + '"'


def _library_lua(arguments):
    """Fallback when Lua is installed as a shared library but has no CLI.

    Execute the very same test_retrieval.lua bridge and memory.lua, in an
    isolated process. There is no Python scoring or retrieval substitution.
    """
    name = next((ctypes.util.find_library(version) for version in ('lua5.4', 'lua5.3')
                 if ctypes.util.find_library(version)), None)
    if not name:
        return 1
    try:
        lua = ctypes.CDLL(name)
        lua.luaL_newstate.restype = ctypes.c_void_p
        lua.luaL_openlibs.argtypes = [ctypes.c_void_p]
        lua.luaL_loadstring.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
        lua.lua_pcallk.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int,
                                 ctypes.c_int, ctypes.c_ssize_t, ctypes.c_void_p]
        lua.lua_close.argtypes = [ctypes.c_void_p]
        state = lua.luaL_newstate()
        if not state:
            return 1
        try:
            lua.luaL_openlibs(state)
            source = ('arg={' + ','.join('[%d]=%s' % (i, _lua_quote(value))
                                        for i, value in enumerate(arguments))
                      + '};dofile(arg[0])').encode()
            return int(bool(lua.luaL_loadstring(state, source)
                            or lua.lua_pcallk(state, 0, 0, 0, 0, None)))
        finally:
            lua.lua_close(state)
    except (AttributeError, OSError):
        return 1


class LuaMemory:
    def __init__(self, executable=None):
        if executable:
            found = shutil.which(executable)
            if not found:
                raise EvaluationError('lua_unavailable')
        else:
            found = next((shutil.which(name) for name in
                          ('lua5.1', 'lua', 'luajit', 'lua5.4', 'lua5.3')
                          if shutil.which(name)), None)
        self.runtime = 'lua_cli' if found else 'lua_shared_library'
        self.command = ([found] if found else
                        [sys.executable, str(Path(__file__).resolve()), '--lua-helper'])
        self.helper = ROOT / 'cognition' / 'test_retrieval.lua'

    def select(self, query, events, strategy, capacity, max_entries, max_chars):
        def hex_text(text):
            return text.encode('utf-8').hex()
        lines = [hex_text(query)]
        for event in events:
            source = event['source']
            identifier = source['id']
            numeric = type(identifier) in (int, float)
            lines.append('\t'.join((str(event['time']), hex_text(source['kind']),
                                    'n' if numeric else 's',
                                    str(identifier) if numeric else hex_text(identifier),
                                    hex_text(event['text']))))
        try:
            run = subprocess.run(self.command + [str(self.helper), '--select', str(capacity),
                                 strategy, str(max_entries), str(max_chars)],
                                 input=('\n'.join(lines) + '\n').encode(),
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                 timeout=5, check=False)
            if run.returncode or len(run.stdout) > 65536:
                raise EvaluationError('lua_execution_failed')
            value = json.loads(run.stdout)
            if (not isinstance(value['entries'], list)
                    or len(value['entries']) > max_entries
                    or not 2 <= value['serialized_chars'] <= max_chars
                    or value['stored_entries'] != min(capacity, len(events))):
                raise EvaluationError('lua_budget_violation')
            return value
        except (OSError, subprocess.TimeoutExpired, ValueError, KeyError, TypeError):
            raise EvaluationError('lua_execution_failed') from None


@dataclass(frozen=True)
class Case:
    task: str
    seed: int
    query: str
    goal: str
    events: list
    nearby: list
    expected: dict
    # Scorer-only oracle. context_for deliberately enumerates provider fields.
    score_oracle: dict = field(default_factory=dict)


def cases(seed):
    rng = random.Random(seed)
    nearby = rng.sample(list(range(41, 49)), 8)
    recipient, informant = nearby[:2]
    old_code, new_code = ('key_' + ''.join(rng.choices('abcdefghjkmnpqrstuvwxyz', k=8))
                          for _ in range(2))
    failed, safe = rng.sample(['basalt', 'willow', 'slate', 'birch'], 2)
    # Roles are chosen before an independent permutation of the displayed IDs.
    # Neither recipient nor informant occupies a prescribed list position.
    rng.shuffle(nearby)

    def event(at, text, kind='agent', identifier=informant):
        return {'time': at, 'text': text, 'source': {'kind': kind, 'id': identifier}}

    # Every pair gets identical chronological streams, query, IDs and budgets.
    # Facts remain in common FIFO storage; the prompt budget forces selection.
    distractors = [event(at, f'Orchard weather observation {at}: clouds moving east.',
                         'observation', nearby[at % len(nearby)]) for at in range(5, 17)]
    prefix = 'Return one legal say action. Its target must be an existing nearby ID. '
    recall = (prefix + f'Tell agent {recipient} the cedar cache passphrase from memory. '
              'Use only the passphrase as text. If unavailable, use text unknown.')
    return [
        Case('delayed_recall', seed, 'cedar cache passphrase', recall,
             [event(1, f'The cedar cache passphrase is {old_code}.')] + distractors,
             nearby, {'kind': 'say', 'target': recipient, 'text': old_code},
             {'abstention_text': 'unknown'}),
        Case('source_attribution', seed, 'amber cache location informant',
             prefix + 'Tell the original informant of the amber cache location, '
             'using the memory source ID as target and text ack. '
             f'If unavailable, tell agent {recipient} with text unknown.',
             [event(1, 'The amber cache location is north meadow.')] + distractors,
             nearby, {'kind': 'say', 'target': informant, 'text': 'ack'},
             {'abstention_text': 'unknown', 'source_attribution': True}),
        Case('stale_fact', seed, 'cedar cache passphrase', recall +
             ' Prefer the latest timestamp when matching facts conflict.',
             [event(1, f'The cedar cache passphrase is {old_code}.'),
              event(3, f'The cedar cache passphrase is {new_code}.')] + distractors,
             nearby, {'kind': 'say', 'target': recipient, 'text': new_code},
             {'abstention_text': 'unknown', 'stale_answer': old_code}),
        Case('avoiding_known_failure', seed, 'bridge crossing failed safe alternative',
             prefix + f'Tell agent {recipient} the safe alternative bridge recorded '
             'after a failed crossing. Use only its name as text; if unavailable use unknown.',
             [event(1, f'The {failed} bridge crossing failed; the safe alternative is {safe}.',
                    'action', recipient)] + distractors,
             nearby, {'kind': 'say', 'target': recipient, 'text': safe},
             {'abstention_text': 'unknown', 'failed_answer': failed}),
    ]


def context_for(case, entries):
    return {'goal': case.goal, 'memory_query': case.query, 'memory': entries,
            'observation': {'pos': {'x': 0, 'y': 0, 'z': 0}, 'has_target': False,
                            'nearby_agents': case.nearby, 'nodes': []},
            'bounds': {'min': {'x': -1, 'y': -1, 'z': -1},
                       'max': {'x': 1, 'y': 1, 'z': 1}}}


def correct_action(action, expected):
    # The adapter projects legal executable actions and adds only `why`.
    return (isinstance(action, dict) and action.get('why') == 'model'
            and {key: value for key, value in action.items() if key != 'why'} == expected)


def score_details(action, expected, oracle=None):
    """Classify an adapter-validated action using only the private Case oracle.

    Labels never contain answers or IDs. None means unmeasured (no validated
    response or an inapplicable task); false means measured and not observed.
    Flags can overlap, while category is exclusive in the precedence below.
    Abstention and known mistakes require exact text, never inferred intent.
    """
    result = {'scored': action is not None, 'category': 'unscored',
              **{flag: None for flag in SCORE_FLAGS}}
    if action is None:
        return result
    oracle = oracle or {}
    say = action.get('kind') == 'say'
    text = action.get('text') if say else None
    if oracle.get('abstention_text') is not None:
        result['abstained'] = say and text == oracle['abstention_text']
    abstained = result['abstained'] is True
    result['wrong_target'] = say and not abstained and action.get('target') != expected.get('target')
    result['wrong_action'] = action.get('kind') != expected.get('kind')
    if oracle.get('source_attribution') is True:
        result['wrong_source_target'] = result['wrong_target']
    if oracle.get('stale_answer') is not None:
        result['stale_fact_used'] = say and text == oracle['stale_answer']
    if oracle.get('failed_answer') is not None:
        result['known_failure_repeated'] = say and text == oracle['failed_answer']
    if correct_action(action, expected):
        result['category'] = 'correct'
    else:
        result['category'] = next((flag for flag in (
            'abstained', 'stale_fact_used', 'known_failure_repeated',
            'wrong_source_target', 'wrong_action', 'wrong_target') if result[flag] is True),
            'wrong_answer')
    return result


def audit_usage(audit):
    """No token estimates: a missing audit keeps the exact total unknown.

    total_tokens may be omitted by a provider; input+output is an exact derived
    total. When supplied it must agree. Booleans are never accepted as counts.
    """
    usage = audit.get('usage') if isinstance(audit, dict) else None
    if isinstance(usage, dict) and usage.get('invalid') is True:
        return {'status': 'invalid', 'tokens': None}
    if not isinstance(usage, dict) or not all(key in usage for key in ('input_tokens', 'output_tokens')):
        return {'status': 'missing', 'tokens': None}
    counts = [usage['input_tokens'], usage['output_tokens']]
    if any(type(value) is not int or not 0 <= value <= 10**9 for value in counts):
        return {'status': 'invalid', 'tokens': None}
    total = sum(counts)
    if 'total_tokens' in usage and (type(usage['total_tokens']) is not int
                                    or usage['total_tokens'] != total):
        return {'status': 'invalid', 'tokens': None}
    return {'status': 'complete', 'tokens': dict(input_tokens=counts[0],
                                                output_tokens=counts[1], total_tokens=total)}


def _goal_recipient(goal):
    match = re.search(r'\b(?:tell|to) agent (\d+)\b', goal, flags=re.IGNORECASE)
    if not match:
        raise ValueError('fixture_missing_recipient')
    return int(match[1])


def _fixture_transport(config, body):
    """Read selected facts, rather than an oracle or strategy, through the API."""
    context = json.loads(json.loads(body)['input'][1]['content'])
    goal = context['goal']
    target = _goal_recipient(goal)
    text = 'unknown'
    facts = sorted(context.get('memory', []), key=lambda event: event['time'], reverse=True)
    if 'original informant' in goal:
        for event in facts:
            if 'amber cache location is' in event['text'] and event['source']['kind'] == 'agent':
                target, text = event['source']['id'], 'ack'
                break
    else:
        pattern = (r'safe alternative is ([a-z]+)' if 'safe alternative bridge' in goal
                   else r'cache passphrase is ([a-z0-9_]+)')
        for event in facts:
            match = re.search(pattern, event['text'])
            if match:
                text = match[1]
                break
    if goal == 'Return a say action to agent 1 with text ack.':
        target, text = 1, 'ack'
    # Explicit synthetic counters test aggregation, never estimate real usage.
    response = {'type': 'response.completed', 'response': {'status': 'completed',
                'output': [{'type': 'message', 'content': [{'type': 'output_text',
                            'text': compact({'kind': 'say', 'target': target, 'text': text})}]}],
                'usage': {'input_tokens': 12, 'output_tokens': 4, 'total_tokens': 16}}}
    return ('data: ' + compact(response) + '\n\n').encode()


def evaluate_decision(config, context, expected, transport=None, *, score_oracle=None):
    """One adapter attempt, including safe failure accounting; never retry."""
    started = time.monotonic()
    audit, error, valid, correct = {}, None, False, False
    details = score_details(None, expected)
    try:
        kwargs = {} if transport is None else {'transport': transport}
        result = adapter.decide(config, context, **kwargs)
        audit = result['audit']
        valid, correct = True, correct_action(result['action'], expected)
        details = score_details(result['action'], expected, score_oracle)
    except adapter.ModelError as exc:
        error = str(exc) if str(exc) in SAFE_ERRORS else 'unexpected_error'
        audit = exc.audit
    except Exception:
        error = 'unexpected_error'
    latency = audit.get('latency_ms') if isinstance(audit, dict) else None
    if type(latency) not in (int, float) or not math.isfinite(latency) or latency < 0:
        latency = None
    return {'valid_action': valid, 'correct': correct, 'error': error,
            'score_details': details,
            'adapter_called': True, 'elapsed_ms': (time.monotonic() - started) * 1000,
            'provider_latency_ms': latency, 'token_audit': audit_usage(audit)}


def _worker(fixture, deadline):
    try:
        raw = sys.stdin.buffer.read(65537)
        if len(raw) > 65536:
            raise ValueError
        payload = json.loads(raw)
        config = (adapter.Config('https://fixture.invalid/v1', 'fixture', 'fixture')
                  if fixture else adapter.Config.from_env())
        config = replace(config, socket_timeout=min(config.socket_timeout, deadline))
        record = evaluate_decision(config, payload['context'], payload['expected'],
                                   _fixture_transport if fixture else None,
                                   score_oracle=payload.get('score_oracle'))
        print(compact(record))
        return 0
    except Exception:
        # Never print exception strings, request context or provider responses.
        return 1


def invoke(context, expected, *, fixture, deadline, score_oracle=None):
    command = [sys.executable, str(Path(__file__).resolve()), '--worker', '--deadline', str(deadline)]
    if fixture:
        command.append('--fixture')
    started = time.monotonic()
    try:
        result = subprocess.run(command, input=compact({'context': context, 'expected': expected,
                                                       'score_oracle': score_oracle}).encode(),
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                timeout=deadline, check=False)
        if result.returncode or len(result.stdout) > 4096:
            raise ValueError
        record = json.loads(result.stdout)
        if not isinstance(record, dict) or set(record) != {
                'valid_action', 'correct', 'error', 'adapter_called', 'elapsed_ms',
                'provider_latency_ms', 'token_audit', 'score_details'}:
            raise ValueError
    except subprocess.TimeoutExpired:
        record = _failed_record('deadline_exceeded')
    except (OSError, ValueError, TypeError):
        record = _failed_record('worker_failed')
    record['wall_ms'] = (time.monotonic() - started) * 1000
    return record


def _failed_record(code):
    return {'valid_action': False, 'correct': False, 'error': code,
            'score_details': score_details(None, {}),
            'adapter_called': None, 'elapsed_ms': None, 'provider_latency_ms': None,
            'token_audit': {'status': 'missing', 'tokens': None}}


def p95(values):
    return sorted(values)[math.ceil(len(values) * .95) - 1] if values else None


def summarize(records):
    totals = dict(input_tokens=0, output_tokens=0, total_tokens=0)
    audits = {'complete': 0, 'missing': 0, 'invalid': 0}
    errors = {}
    categories = dict.fromkeys(SCORE_CATEGORIES, 0)
    flags = {flag: {'count': 0, 'measured': 0} for flag in SCORE_FLAGS}
    for record in records:
        details = record['score_details']
        categories[details['category']] += 1
        for flag in SCORE_FLAGS:
            value = details[flag]
            if type(value) is bool:
                flags[flag]['measured'] += 1
                flags[flag]['count'] += int(value)
        audit = record['token_audit']
        audits[audit['status']] += 1
        if audit['tokens'] is not None:
            for key in totals:
                totals[key] += audit['tokens'][key]
        if record['error']:
            errors[record['error']] = errors.get(record['error'], 0) + 1
    return {'requests': len(records), 'valid_actions': sum(r['valid_action'] for r in records),
            'correct': sum(r['correct'] for r in records),
            'score_categories': categories, 'score_flags': flags,
            'incorrect': sum(r['valid_action'] and not r['correct'] for r in records),
            'errors': errors, 'error_count': sum(errors.values()),
            'adapter_completions': sum(r['adapter_called'] is True for r in records),
            'attempts_unconfirmed': sum(r['adapter_called'] is None for r in records),
            'token_audits': audits, 'known_token_totals': totals,
            'exact_token_totals': totals if audits['complete'] == len(records) else None,
            'p95_wall_ms': p95([r['wall_ms'] for r in records]),
            'p95_provider_ms': p95([r['provider_latency_ms'] for r in records
                                    if r['provider_latency_ms'] is not None])}


def task_suite(lua, seeds, *, capacity=16, max_entries=2, max_chars=512,
               fixture=False, deadline=30, max_calls=48):
    if len(seeds) * 8 > min(max_calls, HARD_CALL_LIMIT):
        raise EvaluationError('call_budget_exceeded')
    records = []
    # Preselect both arms before any provider call; a missing Lua runtime cannot
    # leave behind a partly charged task suite. Alternate pair order across seeds.
    plan = []
    for seed_index, seed in enumerate(seeds):
        for task_index, case in enumerate(cases(seed)):
            order = ('fifo', 'retrieval') if (seed_index + task_index) % 2 == 0 else ('retrieval', 'fifo')
            for strategy in order:
                selection = lua.select(case.query, case.events, strategy,
                                       capacity, max_entries, max_chars)
                plan.append((case, strategy, selection))
    for case, strategy, selection in plan:
        context = context_for(case, selection['entries'])
        record = invoke(context, case.expected, fixture=fixture, deadline=deadline,
                        score_oracle=case.score_oracle)
        record.update(task=case.task, seed=case.seed, strategy=strategy,
                      event_stream_sha256=digest(case.events), query_sha256=digest(case.query),
                      goal_sha256=digest(case.goal), context_sha256=digest(context),
                      selected_memory_sha256=digest(selection['entries']),
                      selected_entries=len(selection['entries']),
                      serialized_chars=selection['serialized_chars'],
                      stored_entries=selection['stored_entries'])
        records.append(record)
    paired = []
    for seed in seeds:
        for case in cases(seed):
            pair = {r['strategy']: r for r in records if r['seed'] == seed and r['task'] == case.task}
            paired.append({'task': case.task, 'seed': seed,
                           'fifo_correct': pair['fifo']['correct'],
                           'retrieval_correct': pair['retrieval']['correct']})
    return {'kind': 'memory_tasks', 'records': records, 'pairs': paired,
            'by_strategy': {strategy: summarize([r for r in records if r['strategy'] == strategy])
                            for strategy in ('fifo', 'retrieval')},
            'summary': summarize(records), 'lua_runtime': lua.runtime,
            'seeds': seeds, 'capacity': capacity, 'max_entries': max_entries, 'max_chars': max_chars,
            'budget_units': 'compact_complete_entry_json_utf8_bytes_including_array_punctuation',
            'limitations': ['Lexical/entity matching with recency ties cannot reliably resolve conflicting facts or paraphrases.',
                            'Synthetic tasks measure exact legal messages, not world action execution.',
                            'Abstention and known mistakes require exact legal say text; other wrong replies are not evidence of stale-fact use or repeated failure.',
                            'Three paired seeds are exploratory, not statistical proof of model quality.']}


def concurrency_probe(levels, *, fixture=False, deadline=30, max_calls=48):
    if len(levels) * PROBE_REQUESTS > min(max_calls, HARD_CALL_LIMIT):
        raise EvaluationError('call_budget_exceeded')
    case = Case('probe', 0, '', 'Return a say action to agent 1 with text ack.', [], [1],
                {'kind': 'say', 'target': 1, 'text': 'ack'})
    context = context_for(case, [])
    records, groups = [], []
    for level in levels:
        started = time.monotonic()
        with ThreadPoolExecutor(max_workers=level) as pool:
            group = list(pool.map(lambda _: invoke(context, case.expected, fixture=fixture,
                                                    deadline=deadline), range(PROBE_REQUESTS)))
        elapsed = time.monotonic() - started
        for record in group:
            record['concurrency'] = level
        records.extend(group)
        summary = summarize(group)
        groups.append({'concurrency': level, 'elapsed_seconds': elapsed,
                       'requests_per_second': len(group) / elapsed,
                       'correct_per_second': summary['correct'] / elapsed, **summary})
    return {'kind': 'concurrency_probe', 'records': records, 'groups': groups,
            'summary': summarize(records), 'context_sha256': digest(context),
            'requests_per_level': PROBE_REQUESTS, 'levels': levels,
            'performance_verdict': 'inconclusive',
            'limitations': ['Single small fixed workload per concurrency level, without repeated alternation or limiter profiling.',
                            'Wall latency and throughput include child startup, adapter validation and provider time.',
                            'Fast failed requests are included in request throughput; correct throughput is separate.',
                            'Provider/network/host contention and token quotas were not independently profiled.']}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture', action='store_true')
    parser.add_argument('--output', type=Path, help='sanitized JSON evidence (stdout if omitted)')
    parser.add_argument('--probe', action='store_true', help='8 requests each at concurrency 1, 2, 4')
    parser.add_argument('--concurrency-probe', nargs='+', type=int, choices=(1, 2, 4),
                        help='separate probe at selected levels (8 requests per level)')
    parser.add_argument('--seeds', nargs='+', type=int, default=[1, 2, 3])
    parser.add_argument('--capacity', type=int, default=16)
    parser.add_argument('--max-entries', type=int, default=2)
    parser.add_argument('--max-chars', type=int, default=512)
    parser.add_argument('--max-calls', type=int, default=48, help='hard upper bound, never above 48')
    parser.add_argument('--deadline', type=float, default=30, help='hard per-call seconds, including child startup')
    parser.add_argument('--lua', help='existing Lua interpreter; no installation is attempted')
    parser.add_argument('--worker', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if not math.isfinite(args.deadline) or not 0 < args.deadline <= 60:
        parser.error('deadline must be in (0, 60]')
    if args.worker:
        return _worker(args.fixture, args.deadline)
    levels = args.concurrency_probe or ([1, 2, 4] if args.probe else None)
    if (not 1 <= args.max_calls <= HARD_CALL_LIMIT
            or (levels and len(set(levels)) != len(levels))
            or not 3 <= len(args.seeds) <= 6 or len(set(args.seeds)) != len(args.seeds)
            or any(not 0 <= seed <= 10**6 for seed in args.seeds)
            or not 1 <= args.capacity <= 128 or not 0 <= args.max_entries <= 128
            or not 2 <= args.max_chars <= 16384):
        parser.error('invalid bounded evaluation configuration')
    calls = len(levels) * PROBE_REQUESTS if levels else len(args.seeds) * 8
    if calls > args.max_calls:
        parser.error('call budget exceeded; no requests started')
    try:
        config = adapter.Config('https://fixture.invalid/v1', 'fixture', 'fixture') if args.fixture else adapter.Config.from_env()
        config.endpoint()  # Fail before selecting memory or starting any model calls.
        kwargs = dict(fixture=args.fixture, deadline=args.deadline, max_calls=args.max_calls)
        report = (concurrency_probe(levels, **kwargs) if levels else
                  task_suite(LuaMemory(args.lua), args.seeds, capacity=args.capacity,
                             max_entries=args.max_entries, max_chars=args.max_chars, **kwargs))
        report.update(schema_version=2, fixture=args.fixture,
                      evidence_kind='synthetic_fixture' if args.fixture else 'actual_configured_model',
                      token_usage_kind='synthetic_fixture' if args.fixture else 'provider_reported',
                      model_sha256=digest(config.model),
                      source_sha256={str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
                                     for path in (ROOT / 'cognition/memory.lua', ROOT / 'cognition/test_retrieval.lua',
                                                  Path(__file__).resolve(), ROOT / 'model/adapter.py')},
                      planned_calls=calls, call_limit=args.max_calls, retries=0,
                      max_output_tokens=256, deadline_seconds=args.deadline,
                      objective='exact_legal_say_action',
                      score_semantics={
                          'oracle_in_provider_context': False,
                          'flags_may_overlap': True,
                          'unmeasured_flag_value': None,
                          'summary_flag_denominator': 'measured',
                          'abstention_match': 'exact_task_oracle_text',
                          'known_mistake_match': 'exact_task_oracle_text',
                          'category_precedence': [
                              'correct', 'abstained', 'stale_fact_used', 'known_failure_repeated',
                              'wrong_source_target', 'wrong_action', 'wrong_target', 'wrong_answer'],
                          'provider_or_validation_failure_category': 'unscored'},
                      audit_ok=report['summary']['exact_token_totals'] is not None)
        output = compact(report) + '\n'
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(output, encoding='utf-8')
        else:
            sys.stdout.write(output)
        # Wrong model answers are valid experimental results. Execution/audit
        # failures remain explicit and fail CI, even when other answers succeed.
        return 0 if report['audit_ok'] and report['summary']['error_count'] == 0 else 1
    except adapter.ModelError:
        print('memory_eval: invalid_model_configuration', file=sys.stderr)
        return 2
    except EvaluationError as exc:
        print('memory_eval: ' + str(exc), file=sys.stderr)
        return 2
    except Exception:
        print('memory_eval: harness_failure', file=sys.stderr)
        return 2


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--lua-helper':
        raise SystemExit(_library_lua(sys.argv[2:]))
    raise SystemExit(main())
