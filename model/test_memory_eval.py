import contextlib
import copy
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

from model import adapter
from model import memory_eval as evaluation


CONFIG = adapter.Config('https://fixture.invalid/v1', 'fixture', 'private-key-never-log')


def other_target(case):
    return next(agent for agent in case.nearby if agent != case.expected['target'])


def response(action, usage=None):
    event = {'type': 'response.completed', 'response': {'status': 'completed',
             'output': [{'type': 'message', 'content': [{'type': 'output_text',
                        'text': json.dumps(action)}]}]}}
    if usage is not None:
        event['response']['usage'] = usage
    return ('data: ' + json.dumps(event) + '\n\n').encode()


def completed_record(correct=True):
    expected = {'kind': 'say', 'target': 1, 'text': 'ack'}
    action = {**expected, 'why': 'model', 'text': 'ack' if correct else 'other'}
    return {'valid_action': True, 'correct': correct, 'error': None,
            'score_details': evaluation.score_details(action, expected),
            'adapter_called': True, 'elapsed_ms': 1, 'provider_latency_ms': 1,
            'wall_ms': 2, 'token_audit': evaluation.audit_usage(
                {'usage': {'input_tokens': 12, 'output_tokens': 4}})}


class MemoryEvaluationTests(unittest.TestCase):
    def test_lua_bridge_selects_real_module_and_preserves_provenance(self):
        lua = evaluation.LuaMemory()
        events = [{'time': 1, 'text': 'needle cache is north',
                   'source': {'kind': 'agent', 'id': 7}},
                  {'time': 2, 'text': 'irrelevant weather',
                   'source': {'kind': 'observation', 'id': 'east'}}]
        retrieved = lua.select('needle cache', events, 'retrieval', 2, 1, 512)
        fifo = lua.select('needle cache', events, 'fifo', 2, 1, 512)
        self.assertEqual(retrieved['entries'], events[:1])
        self.assertEqual(fifo['entries'], events[1:])
        self.assertEqual(retrieved['serialized_chars'], len(json.dumps(
            events[:1], separators=(',', ':')).encode()))
        evicted = lua.select('needle cache', events, 'retrieval', 1, 1, 512)
        self.assertEqual(evicted['entries'], events[1:])
        self.assertEqual(evicted['stored_entries'], 1)

    def test_lua_bridge_budget_counts_escaping_provenance_and_complete_entries(self):
        event = {'time': 1, 'text': 'needle "quoted"\n\\你好',
                 'source': {'kind': 'agent', 'id': 'provenance-' * 8}}
        lua = evaluation.LuaMemory()
        full = lua.select('needle', [event], 'retrieval', 2, 2, 1024)
        self.assertEqual(full['entries'], [event])
        budget = full['serialized_chars']
        for strategy in ('fifo', 'retrieval'):
            with self.subTest(strategy=strategy):
                self.assertEqual(lua.select('needle', [event], strategy, 2, 2,
                                            budget)['entries'], [event])
                self.assertEqual(lua.select('needle', [event], strategy, 2, 2,
                                            budget - 1)['entries'], [])

    def test_fixture_suite_exercises_adapter_and_alternating_lua_pairs(self):
        lua = evaluation.LuaMemory()
        seen = []

        def offline(context, expected, **kwargs):
            seen.append(copy.deepcopy(context))
            result = evaluation.evaluate_decision(CONFIG, context, expected,
                                                  evaluation._fixture_transport,
                                                  score_oracle=kwargs.get('score_oracle'))
            result['wall_ms'] = 1
            return result

        with mock.patch.object(evaluation, 'invoke', side_effect=offline):
            report = evaluation.task_suite(lua, [1, 2, 3], fixture=True)
        self.assertEqual(len(seen), 24)
        self.assertEqual(report['by_strategy']['fifo']['correct'], 0)
        self.assertEqual(report['by_strategy']['retrieval']['correct'], 12)
        self.assertEqual(report['summary']['exact_token_totals']['total_tokens'], 384)
        self.assertEqual(len({r['task'] for r in report['records']}), 4)
        for i in range(0, 24, 2):
            left, right = report['records'][i:i + 2]
            self.assertNotEqual(left['strategy'], right['strategy'])
            for key in ('task', 'seed', 'event_stream_sha256', 'query_sha256', 'goal_sha256'):
                self.assertEqual(left[key], right[key])
            self.assertLessEqual(left['serialized_chars'], 512)
            self.assertLessEqual(right['serialized_chars'], 512)
            self.assertLessEqual(left['selected_entries'], 2)
            self.assertLessEqual(right['selected_entries'], 2)
            # Same IDs, bounds, query, and goal. Only selected memory changes.
            a, b = seen[i:i + 2]
            a.pop('memory'); b.pop('memory')
            self.assertEqual(a, b)
        first_by_seed = [next(r['strategy'] for r in report['records'] if r['seed'] == seed)
                         for seed in (1, 2, 3)]
        self.assertEqual(first_by_seed, ['fifo', 'retrieval', 'fifo'])

    def test_generation_is_seeded_and_expected_ids_exist(self):
        self.assertEqual(evaluation.cases(7), evaluation.cases(7))
        self.assertNotEqual(evaluation.cases(7), evaluation.cases(8))
        for seed in (1, 2, 3):
            for case in evaluation.cases(seed):
                self.assertIn(case.expected['target'], case.nearby)
                self.assertLessEqual(len(case.events), 16)
        source = evaluation.cases(1)[1]
        self.assertEqual(source.expected['target'], source.events[0]['source']['id'])

    def test_exact_scorer_rejects_guessing_wrong_source_and_wrong_actions(self):
        case = evaluation.cases(1)[1]
        context = evaluation.context_for(case, case.events[:1])
        correct = evaluation.evaluate_decision(CONFIG, context, case.expected,
                                               lambda *_: response(case.expected))
        self.assertTrue(correct['correct'])
        for action in ({**case.expected, 'target': other_target(case)},
                       {**case.expected, 'text': 'ack extra'}, {'kind': 'inspect'}):
            record = evaluation.evaluate_decision(CONFIG, context, case.expected,
                                                   lambda *_, action=action: response(action))
            self.assertTrue(record['valid_action'])
            self.assertFalse(record['correct'])
        illegal = evaluation.evaluate_decision(CONFIG, context, case.expected,
                                               lambda *_: response({**case.expected, 'target': 99999}))
        self.assertEqual(illegal['error'], 'invalid_action')
        self.assertFalse(illegal['correct'])

    def test_usage_is_exact_or_explicitly_missing_invalid_never_estimated(self):
        self.assertEqual(evaluation.audit_usage({'usage': {'input_tokens': 7, 'output_tokens': 3}}),
                         {'status': 'complete', 'tokens': {'input_tokens': 7,
                                                          'output_tokens': 3, 'total_tokens': 10}})
        for audit in (None, {}, {'usage': {}}, {'usage': {'input_tokens': 7}}):
            self.assertEqual(evaluation.audit_usage(audit)['status'], 'missing')
        for usage in ({'input_tokens': True, 'output_tokens': 3},
                      {'input_tokens': -1, 'output_tokens': 3},
                      {'input_tokens': 7.0, 'output_tokens': 3},
                      {'input_tokens': 7, 'output_tokens': 3, 'total_tokens': 99},
                      {'input_tokens': 0, 'output_tokens': 0, 'total_tokens': False}):
            self.assertEqual(evaluation.audit_usage({'usage': usage})['status'], 'invalid')

    def test_invalid_actions_keep_failure_tokens_and_provider_failures_count_unknown(self):
        case = evaluation.cases(2)[1]
        context = evaluation.context_for(case, [])
        transport = mock.Mock(return_value=response(
            {**case.expected, 'target': 999}, {'input_tokens': 13, 'output_tokens': 9}))
        record = evaluation.evaluate_decision(CONFIG, context, case.expected, transport)
        transport.assert_called_once()
        self.assertEqual(record['error'], 'invalid_action')
        self.assertEqual(record['token_audit']['tokens']['total_tokens'], 22)
        record['wall_ms'] = 1
        failure = evaluation.evaluate_decision(CONFIG, context, case.expected,
                    lambda *_: b'data: {"type":"response.failed","secret":"private-context"}\n\n')
        failure['wall_ms'] = 1
        summary = evaluation.summarize([record, failure])
        self.assertEqual(summary['known_token_totals']['total_tokens'], 22)
        self.assertIsNone(summary['exact_token_totals'])
        self.assertEqual(summary['error_count'], 2)
        self.assertEqual(summary['token_audits'], {'complete': 1, 'missing': 1, 'invalid': 0})
        self.assertNotIn('private-context', json.dumps(failure))

    def test_exceptions_and_audit_extras_cannot_leak_into_evidence(self):
        case = evaluation.cases(2)[0]
        context = evaluation.context_for(case, [])
        with mock.patch.object(adapter, 'decide', side_effect=adapter.ModelError(
                'secret-provider-response', audit={'usage': {}, 'raw': 'private-key-never-log'})):
            record = evaluation.evaluate_decision(CONFIG, context, case.expected)
        self.assertEqual(record['error'], 'unexpected_error')
        self.assertNotIn('secret-provider-response', json.dumps(record))
        self.assertNotIn('private-key-never-log', json.dumps(record))
        with mock.patch.object(adapter, 'decide', side_effect=RuntimeError('raw-provider-text')):
            record = evaluation.evaluate_decision(CONFIG, context, case.expected)
        self.assertNotIn('raw-provider-text', json.dumps(record))

    def test_parent_enforces_hard_deadline_without_retries(self):
        with mock.patch.object(evaluation.subprocess, 'run',
                side_effect=subprocess.TimeoutExpired('private-context', .01)) as run:
            record = evaluation.invoke({}, {}, fixture=True, deadline=.01)
        run.assert_called_once()
        self.assertEqual(run.call_args.kwargs['timeout'], .01)
        self.assertEqual(record['error'], 'deadline_exceeded')
        self.assertIsNone(record['adapter_called'])
        self.assertEqual(record['token_audit']['status'], 'missing')

    def test_worker_failure_is_sanitized(self):
        with mock.patch.object(evaluation.subprocess, 'run',
                return_value=subprocess.CompletedProcess([], 1, b'private-provider-body')):
            record = evaluation.invoke({}, {}, fixture=True, deadline=1)
        self.assertEqual(record['error'], 'worker_failed')
        self.assertNotIn('private-provider-body', json.dumps(record))

    def test_bounded_calls_preflight_before_work(self):
        lua = mock.Mock()
        with mock.patch.object(evaluation, 'invoke') as invoke:
            with self.assertRaisesRegex(evaluation.EvaluationError, 'call_budget_exceeded'):
                evaluation.task_suite(lua, list(range(7)))
            with self.assertRaisesRegex(evaluation.EvaluationError, 'call_budget_exceeded'):
                evaluation.task_suite(lua, [1, 2, 3], max_calls=23)
            with self.assertRaisesRegex(evaluation.EvaluationError, 'call_budget_exceeded'):
                evaluation.concurrency_probe([1, 2, 4], max_calls=23)
            lua.select.assert_not_called()
            invoke.assert_not_called()

    def test_lua_failure_happens_before_any_provider_attempt(self):
        lua = mock.Mock()
        lua.select.side_effect = [dict(entries=[], stored_entries=13, serialized_chars=2),
                                  evaluation.EvaluationError('lua_execution_failed')]
        with mock.patch.object(evaluation, 'invoke') as invoke:
            with self.assertRaisesRegex(evaluation.EvaluationError, 'lua_execution_failed'):
                evaluation.task_suite(lua, [1, 2, 3])
            invoke.assert_not_called()

    def test_fixture_subprocess_and_probe_modes(self):
        # Real process boundary with the adapter SSE parser and action validator.
        case = evaluation.cases(1)[0]
        record = evaluation.invoke(evaluation.context_for(case, case.events[:1]), case.expected,
                                   fixture=True, deadline=5)
        self.assertTrue(record['correct'])
        self.assertEqual(record['token_audit']['status'], 'complete')
        received = []

        def fake(context, expected, **kwargs):
            received.append(evaluation.compact(context))
            return completed_record()

        with mock.patch.object(evaluation, 'invoke', side_effect=fake):
            probe = evaluation.concurrency_probe([1, 2, 4], fixture=True)
        self.assertEqual(len(received), 24)
        self.assertEqual(len(set(received)), 1)
        self.assertEqual([g['concurrency'] for g in probe['groups']], [1, 2, 4])
        self.assertEqual([g['requests'] for g in probe['groups']], [8, 8, 8])
        self.assertEqual(probe['summary']['correct'], 24)
        self.assertEqual(probe['performance_verdict'], 'inconclusive')
        self.assertEqual(evaluation.p95(list(range(1, 21))), 19)

    def test_cli_fixture_report_contains_only_sanitized_evidence(self):
        out = io.StringIO()
        with mock.patch.object(evaluation, 'invoke', side_effect=lambda *a, **k: completed_record()), \
                contextlib.redirect_stdout(out):
            code = evaluation.main(['--fixture', '--probe'])
        self.assertEqual(code, 0)
        report = json.loads(out.getvalue())
        self.assertEqual(report['planned_calls'], 24)
        self.assertEqual(report['retries'], 0)
        self.assertTrue(report['fixture'])
        self.assertEqual(report['token_usage_kind'], 'synthetic_fixture')
        self.assertEqual(report['evidence_kind'], 'synthetic_fixture')
        self.assertTrue(report['audit_ok'])
        for forbidden in ('base_url', 'api_key', 'nearby_agents', 'goal', 'text', 'raw', 'context'):
            self.assertNotIn('"' + forbidden + '":', out.getvalue())

    def test_cli_fails_audit_even_if_actions_are_correct(self):
        record = completed_record()
        record['token_audit'] = {'status': 'missing', 'tokens': None}
        out = io.StringIO()
        with mock.patch.object(evaluation, 'invoke', side_effect=lambda *a, **k: copy.deepcopy(record)), \
                contextlib.redirect_stdout(out):
            code = evaluation.main(['--fixture', '--concurrency-probe', '1'])
        self.assertEqual(code, 1)
        report = json.loads(out.getvalue())
        self.assertIsNone(report['summary']['exact_token_totals'])
        self.assertEqual(report['summary']['correct'], 8)
        self.assertFalse(report['audit_ok'])

    def test_cli_output_file_is_reviewable_and_stdout_stays_empty(self):
        out = io.StringIO()
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as directory:
            path = Path(directory) / 'results' / 'probe.json'
            with mock.patch.object(evaluation, 'invoke', side_effect=lambda *a, **k: completed_record()), \
                    contextlib.redirect_stdout(out):
                code = evaluation.main(['--fixture', '--probe', '--output', str(path)])
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(path.read_text())['summary']['requests'], 24)
            self.assertEqual(out.getvalue(), '')

    def test_real_worker_uses_existing_configured_adapter_once_without_fixture(self):
        case = evaluation.cases(3)[0]
        context = evaluation.context_for(case, case.events[:1])
        payload = evaluation.compact({'context': context, 'expected': case.expected}).encode()
        out = io.StringIO()
        with mock.patch.object(adapter.Config, 'from_env', return_value=CONFIG), \
                mock.patch.object(adapter, 'decide', return_value={
                    'action': {**case.expected, 'why': 'model'},
                    'audit': {'latency_ms': 1, 'usage': {'input_tokens': 5, 'output_tokens': 2}}}) as decide, \
                mock.patch.object(evaluation.sys, 'stdin', mock.Mock(buffer=io.BytesIO(payload))), \
                contextlib.redirect_stdout(out):
            self.assertEqual(evaluation._worker(False, 5), 0)
        decide.assert_called_once()
        config, passed_context = decide.call_args.args
        self.assertEqual(passed_context, context)
        self.assertEqual(config.model, CONFIG.model)
        self.assertEqual(config.base_url, CONFIG.base_url)
        self.assertEqual(config.api_key, CONFIG.api_key)
        self.assertEqual(config.socket_timeout, 5)
        self.assertEqual(decide.call_args.kwargs, {})
        self.assertTrue(json.loads(out.getvalue())['correct'])
        self.assertNotIn(CONFIG.api_key, out.getvalue())

    def test_cli_invalid_arguments_never_launch_workers(self):
        with mock.patch.object(evaluation, 'invoke') as invoke:
            for options in (['--max-calls', '23'], ['--max-calls', '49'],
                            ['--deadline', 'nan'], ['--seeds', '1', '1', '2'],
                            ['--seeds', '1', '2'], ['--concurrency-probe', '1', '1']):
                with self.subTest(options=options), contextlib.redirect_stderr(io.StringIO()):
                    with self.assertRaises(SystemExit) as error:
                        evaluation.main(['--fixture'] + options)
                    self.assertEqual(error.exception.code, 2)
            invoke.assert_not_called()

    def test_real_mode_invalid_config_does_not_call_model(self):
        with mock.patch.object(adapter.Config, 'from_env',
                               return_value=adapter.Config('', '', '')), \
             mock.patch.object(evaluation, 'invoke') as invoke:
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(evaluation.main([]), 2)
            invoke.assert_not_called()


class FinalContractTests(unittest.TestCase):
    """Generation and mocked-adapter regressions; no fixture/provider requests."""

    def test_role_positions_are_shuffled_after_assignment_and_seeded(self):
        positions = {'recipient': set(), 'informant': set()}
        for seed in range(24):
            generated = evaluation.cases(seed)
            recall, source = generated[:2]
            self.assertEqual(generated, evaluation.cases(seed))
            self.assertEqual(recall.nearby, source.nearby)
            recipient, informant = recall.expected['target'], source.expected['target']
            self.assertNotEqual(recipient, informant)
            self.assertEqual(informant, source.events[0]['source']['id'])
            positions['recipient'].add(recall.nearby.index(recipient))
            positions['informant'].add(source.nearby.index(informant))
        self.assertGreater(len(positions['recipient']), 1)
        self.assertGreater(len(positions['informant']), 1)
        self.assertNotEqual(positions['recipient'], {0})
        self.assertNotEqual(positions['informant'], {1})

    def test_goal_fallback_recipient_is_not_inferred_from_nearby_position(self):
        different_from_first = False
        for seed in range(12):
            recall, source = evaluation.cases(seed)[:2]
            parsed = evaluation._goal_recipient(source.goal)
            self.assertEqual(parsed, recall.expected['target'])
            self.assertNotEqual(parsed, source.expected['target'])
            different_from_first |= parsed != source.nearby[0]
        self.assertTrue(different_from_first)
        self.assertEqual(evaluation._goal_recipient('Return a say action to agent 1 with text ack.'), 1)

    def test_invalid_marker_precedes_missing_or_otherwise_valid_usage(self):
        for usage in ({'invalid': True},
                      {'input_tokens': 12, 'invalid': True},
                      {'input_tokens': 12, 'output_tokens': 4, 'invalid': True},
                      {'input_tokens': 12, 'output_tokens': 4, 'total_tokens': 16,
                       'invalid': True}):
            with self.subTest(usage=usage):
                self.assertEqual(evaluation.audit_usage({'usage': usage}),
                                 {'status': 'invalid', 'tokens': None})
        self.assertEqual(evaluation.audit_usage({'usage': {
            'input_tokens': 12, 'output_tokens': 4, 'invalid': False}})['status'], 'complete')

    def test_invalid_marker_fails_report_audit_even_when_answer_correct(self):
        case = evaluation.cases(1)[0]
        with mock.patch.object(adapter, 'decide', return_value={
                'action': {**case.expected, 'why': 'model'},
                'audit': {'usage': {'input_tokens': 12, 'output_tokens': 4, 'invalid': True}}}):
            record = evaluation.evaluate_decision(CONFIG, evaluation.context_for(case, []),
                                                  case.expected, score_oracle=case.score_oracle)
        self.assertTrue(record['correct'])
        record['wall_ms'] = 1
        summary = evaluation.summarize([record])
        self.assertEqual(summary['token_audits']['invalid'], 1)
        self.assertIsNone(summary['exact_token_totals'])
        self.assertEqual(summary['known_token_totals']['total_tokens'], 0)

    def test_rate_limit_retains_safe_error_and_is_not_retried(self):
        case = evaluation.cases(1)[0]
        with mock.patch.object(adapter, 'decide', side_effect=adapter.ModelError(
                'rate_limited', audit={'usage': {}})) as decide:
            record = evaluation.evaluate_decision(CONFIG, evaluation.context_for(case, []),
                                                  case.expected, score_oracle=case.score_oracle)
        decide.assert_called_once()
        self.assertEqual(record['error'], 'rate_limited')
        self.assertEqual(record['score_details']['category'], 'unscored')
        record['wall_ms'] = 1
        summary = evaluation.summarize([record])
        self.assertEqual(summary['errors'], {'rate_limited': 1})
        self.assertEqual(summary['token_audits']['missing'], 1)
        self.assertIsNone(summary['exact_token_totals'])


class ScoreDetailTests(unittest.TestCase):
    """Pure scorer/mocked-adapter checks; no fixture or provider requests."""

    def score(self, case, action):
        return evaluation.score_details({**action, 'why': 'model'},
                                        case.expected, case.score_oracle)

    def test_only_exact_abstention_is_abstained_not_wrong_source(self):
        case = evaluation.cases(1)[1]
        abstain = {'kind': 'say', 'target': case.nearby[0], 'text': 'unknown'}
        details = self.score(case, abstain)
        self.assertEqual(details['category'], 'abstained')
        self.assertTrue(details['abstained'])
        self.assertFalse(details['wrong_source_target'])
        for text in ('Unknown', 'unknown location', 'I do not know'):
            with self.subTest(text=text):
                details = self.score(case, {**case.expected, 'text': text})
                self.assertEqual(details['category'], 'wrong_answer')
                self.assertFalse(details['abstained'])

    def test_wrong_source_target_is_task_specific_and_primary_score_stays_exact(self):
        case = evaluation.cases(1)[1]
        wrong = {**case.expected, 'target': other_target(case)}
        details = self.score(case, wrong)
        self.assertEqual(details['category'], 'wrong_source_target')
        self.assertTrue(details['wrong_source_target'])
        self.assertTrue(details['wrong_target'])
        self.assertIsNone(details['stale_fact_used'])
        self.assertIsNone(details['known_failure_repeated'])
        self.assertFalse(evaluation.correct_action({**wrong, 'why': 'model'}, case.expected))
        self.assertEqual(self.score(case, case.expected)['category'], 'correct')
        other = evaluation.cases(1)[0]
        details = self.score(other, {**other.expected, 'target': other_target(other)})
        self.assertEqual(details['category'], 'wrong_target')
        self.assertIsNone(details['wrong_source_target'])

    def test_stale_fact_requires_old_code_match_not_any_wrong_answer(self):
        case = evaluation.cases(2)[2]
        old = case.score_oracle['stale_answer']
        details = self.score(case, {**case.expected, 'text': old})
        self.assertEqual(details['category'], 'stale_fact_used')
        self.assertTrue(details['stale_fact_used'])
        for text, category in (('unknown', 'abstained'), ('invented_code', 'wrong_answer'),
                               (old + ' maybe', 'wrong_answer'),
                               (case.expected['text'], 'correct')):
            with self.subTest(text=text):
                details = self.score(case, {**case.expected, 'text': text})
                self.assertEqual(details['category'], category)
                self.assertFalse(details['stale_fact_used'])
        self.assertNotIn(old, evaluation.compact(details))

    def test_failed_bridge_requires_failed_name_and_overlapping_flags_are_explicit(self):
        case = evaluation.cases(3)[3]
        failed = case.score_oracle['failed_answer']
        details = self.score(case, {**case.expected, 'text': failed, 'target': other_target(case)})
        self.assertEqual(details['category'], 'known_failure_repeated')
        self.assertTrue(details['known_failure_repeated'])
        self.assertTrue(details['wrong_target'])
        self.assertIsNone(details['stale_fact_used'])
        for text, category in (('unknown', 'abstained'), ('unrelated_bridge', 'wrong_answer'),
                               (failed + ' bridge', 'wrong_answer'),
                               (case.expected['text'], 'correct')):
            with self.subTest(text=text):
                details = self.score(case, {**case.expected, 'text': text})
                self.assertEqual(details['category'], category)
                self.assertFalse(details['known_failure_repeated'])
        self.assertEqual(self.score(case, {'kind': 'inspect'})['category'], 'wrong_action')

    def test_provider_and_validation_failures_are_unscored_not_known_mistakes(self):
        case = evaluation.cases(2)[2]
        for error in ('provider_failed', 'invalid_action', 'transport_error'):
            with self.subTest(error=error), mock.patch.object(
                    adapter, 'decide', side_effect=adapter.ModelError(error)):
                record = evaluation.evaluate_decision(
                    CONFIG, evaluation.context_for(case, []), case.expected,
                    score_oracle=case.score_oracle)
                self.assertFalse(record['correct'])
                self.assertFalse(record['score_details']['scored'])
                self.assertEqual(record['score_details']['category'], 'unscored')
                self.assertTrue(all(record['score_details'][flag] is None
                                    for flag in evaluation.SCORE_FLAGS))
        timeout = evaluation._failed_record('deadline_exceeded')
        timeout['wall_ms'] = 1
        summary = evaluation.summarize([timeout])
        self.assertEqual(summary['score_categories']['unscored'], 1)
        self.assertTrue(all(v == {'count': 0, 'measured': 0}
                            for v in summary['score_flags'].values()))

    def test_worker_scores_private_oracle_without_passing_it_to_adapter_or_logging_it(self):
        case = evaluation.cases(2)[2]
        context = evaluation.context_for(case, [])
        old = case.score_oracle['stale_answer']
        payload = evaluation.compact({'context': context, 'expected': case.expected,
                                      'score_oracle': case.score_oracle}).encode()
        action = {**case.expected, 'text': old, 'why': 'model'}
        out = io.StringIO()
        with mock.patch.object(adapter.Config, 'from_env', return_value=CONFIG), \
                mock.patch.object(adapter, 'decide', return_value={
                    'action': action, 'audit': {'usage': {'input_tokens': 5, 'output_tokens': 2}}}) as decide, \
                mock.patch.object(evaluation.sys, 'stdin', mock.Mock(buffer=io.BytesIO(payload))), \
                contextlib.redirect_stdout(out):
            self.assertEqual(evaluation._worker(False, 5), 0)
        decide.assert_called_once()
        self.assertEqual(decide.call_args.args[1], context)
        self.assertEqual(decide.call_args.kwargs, {})
        self.assertNotIn(old, evaluation.compact(context))
        self.assertNotIn('score_oracle', context)
        self.assertNotIn('expected', context)
        record = json.loads(out.getvalue())
        self.assertFalse(record['correct'])
        self.assertTrue(record['score_details']['stale_fact_used'])
        self.assertNotIn(old, out.getvalue())
        self.assertNotIn(CONFIG.api_key, out.getvalue())

    def test_invoke_serializes_oracle_outside_provider_context(self):
        case = evaluation.cases(3)[3]
        context = evaluation.context_for(case, [])
        record = completed_record()
        record.pop('wall_ms')
        with mock.patch.object(evaluation.subprocess, 'run', return_value=
                subprocess.CompletedProcess([], 0, evaluation.compact(record).encode())) as run:
            evaluation.invoke(context, case.expected, fixture=False, deadline=1,
                              score_oracle=case.score_oracle)
        run.assert_called_once()
        payload = json.loads(run.call_args.kwargs['input'])
        self.assertEqual(payload['score_oracle'], case.score_oracle)
        self.assertEqual(payload['context'], context)
        self.assertNotIn('score_oracle', payload['context'])
        self.assertNotIn('failed_answer', evaluation.compact(payload['context']))

    def test_task_summary_counts_categories_and_only_applicable_flags(self):
        lua = mock.Mock(runtime='mock')
        lua.select.return_value = {'entries': [], 'stored_entries': 13, 'serialized_chars': 2}

        def mocked_decision(context, expected, *, score_oracle, **kwargs):
            record = completed_record()
            record['score_details'] = evaluation.score_details(
                {**expected, 'why': 'model'}, expected, score_oracle)
            return record

        with mock.patch.object(evaluation, 'invoke', side_effect=mocked_decision):
            report = evaluation.task_suite(lua, [1, 2, 3])
        summary = report['summary']
        self.assertEqual(summary['correct'], 24)
        self.assertEqual(summary['score_categories']['correct'], 24)
        self.assertEqual(sum(summary['score_categories'].values()), 24)
        self.assertEqual(summary['score_flags']['abstained'], {'count': 0, 'measured': 24})
        for flag in ('wrong_source_target', 'stale_fact_used', 'known_failure_repeated'):
            self.assertEqual(summary['score_flags'][flag], {'count': 0, 'measured': 6})
            self.assertEqual(report['by_strategy']['retrieval']['score_flags'][flag],
                             {'count': 0, 'measured': 3})

    def test_summary_does_not_relabel_wrong_answers_as_known_mistakes(self):
        records = []
        for case in evaluation.cases(1):
            record = completed_record(False)
            record['score_details'] = self.score(case, {**case.expected, 'text': 'unrelated_answer'})
            records.append(record)
        summary = evaluation.summarize(records)
        self.assertEqual(summary['score_categories']['wrong_answer'], 4)
        self.assertEqual(summary['score_categories']['stale_fact_used'], 0)
        self.assertEqual(summary['score_categories']['known_failure_repeated'], 0)
        self.assertEqual(summary['score_flags']['stale_fact_used'], {'count': 0, 'measured': 1})
        self.assertEqual(summary['score_flags']['known_failure_repeated'], {'count': 0, 'measured': 1})


if __name__ == '__main__':
    unittest.main()
