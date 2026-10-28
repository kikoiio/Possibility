"""Small, engine-free checks of comparison results and retained evidence."""
import gzip
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import compare


class InspectRunTests(unittest.TestCase):
    # Three agents each finish two decisions: six decisions and three cadence gaps.
    EVENTS = (
        'configuration optimized=false frame_budget_ms=2.0 profile=false',
        'check stage=spawn alive=3 expected=3 ok=true',
        'ev=mark agent=1 persona=maker at=0,1,0 marks_total=1',
        'round number=1 wall_ms=100 cpu_ms=0.25',
        'stats t=5.0 agents=3/3 stepped_delta=3 steps_per_sec=10.5 decisions=3',
        'round number=2 wall_ms=200 cpu_ms=0.75',
        'stats t=10.0 agents=3/3 stepped_delta=3 steps_per_sec=11.5 decisions=6',
        'performance elapsed_s=2 decisions_per_sec=3 object_queries=6',
        'cadence samples=3 mean_s=2 min_s=2 max_s=2 target_s=2',
        'summary spawned=3 alive=3 decisions=6 rounds=2 marks=1 meetings=0',
        'done result=ok reason=decisions-reached',
        'verify marks_counter=1 marks_in_world=1 ok=true',
    )

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='test-compare-')
        self.addCleanup(temporary.cleanup)
        self.evidence = Path(temporary.name) / 'agent' / 'evidence'
        self.evidence.mkdir(parents=True)
        exp = patch.object(compare, 'EXP', Path(temporary.name))
        exp.start()
        self.addCleanup(exp.stop)

    def changed_events(self, prefix, replacement):
        events = list(self.EVENTS)
        for i, event in enumerate(events):
            if event.startswith(prefix):
                if replacement is None:
                    del events[i]
                else:
                    events[i] = replacement
                return events
        self.fail('fixture has no event beginning with ' + prefix)

    def inspect(self, events=None, *, label='tiny', exit_code=0,
                timestamp='2026-10-28 12:00:00', validation='  结果: PASS\n'):
        events = self.EVENTS if events is None else events
        self.log = self.evidence / (label + '.run1.log')
        self.report = self.evidence / (label + '.run1.report.txt')
        self.event_file = self.evidence / (label + '.run1.events')
        self.raw_log = ('engine startup: 世界\n' + ''.join(
            f'{timestamp}: ACTION[Server]: SOCIETY {event}\n' for event in events
        ) + 'engine shutdown\n').encode('utf-8')
        self.report_header = (
            f'=== M0 运行报告 {label}.run1 ===\n峰值 RSS: 42 MiB\n\n'
            '--- 校验 ---\n' + validation + '\n'
        )
        self.log.write_bytes(self.raw_log)
        self.report.write_text(
            self.report_header + '--- SOCIETY 事件（原文）---\n'
            + self.raw_log.decode('utf-8'), encoding='utf-8',
        )
        self.event_file.write_text('\n'.join(events) + '\n', encoding='utf-8')
        return compare.inspect_run(label, count=3, decisions=2, exit_code=exit_code)

    def test_complete_workload_reports_correct_results(self):
        result = self.inspect()
        self.assertIs(result['correct'], True)
        self.assertIs(result['realtime_pass'], True)
        self.assertEqual(result['exit_code'], 0)
        self.assertEqual(result['failures'], [])
        self.assertEqual(result['summary']['decisions'], '6')
        self.assertEqual(result['cadence']['samples'], 3)
        self.assertEqual(result['steps_per_sec'],
                         {'n': 2, 'median': 11.0, 'min': 10.5, 'max': 11.5})
        self.assertEqual(result['round_wall_ms'],
                         {'n': 2, 'median': 150, 'min': 100, 'max': 200})
        self.assertEqual(result['round_active_ms'],
                         {'n': 2, 'median': 0.5, 'min': 0.25, 'max': 0.75})
        self.assertEqual(result['peak_engine_rss_mib'], 42)

    def test_missing_or_incorrect_decisions_reject_workload(self):
        summaries = (
            None,
            'summary spawned=3 alive=3 rounds=2 marks=1 meetings=0',
            'summary spawned=3 alive=3 decisions=0 rounds=2 marks=1 meetings=0',
            'summary spawned=3 alive=3 decisions=5 rounds=2 marks=1 meetings=0',
            'summary spawned=3 alive=3 decisions=7 rounds=2 marks=1 meetings=0',
        )
        for summary in summaries:
            with self.subTest(summary=summary):
                result = self.inspect(self.changed_events('summary ', summary))
                self.assertIs(result['correct'], False)

    def test_missing_or_dropped_alive_agents_reject_workload(self):
        for alive in ('', 'alive=2 ', 'alive=0 '):
            with self.subTest(alive=alive):
                events = self.changed_events(
                    'summary ', f'summary spawned=3 {alive}decisions=6 rounds=2 marks=1 meetings=0',
                )
                self.assertIs(self.inspect(events)['correct'], False)

    def test_understepped_interval_rejects_even_if_other_intervals_are_complete(self):
        for time, decisions in ((5, 3), (10, 6)):
            with self.subTest(time=time):
                events = self.changed_events(
                    f'stats t={time}.0 ',
                    f'stats t={time}.0 agents=3/3 stepped_delta=2 steps_per_sec=11 decisions={decisions}',
                )
                self.assertIs(self.inspect(events)['correct'], False)

    def test_missing_step_samples_reject_workload(self):
        events = [event for event in self.EVENTS if not event.startswith('stats ')]
        self.assertIs(self.inspect(events)['correct'], False)

    def test_engine_failure_vetoes_otherwise_complete_workload(self):
        failure = 'fail=no-position agent=2 persona=maker'
        events = list(self.EVENTS)
        events.insert(3, failure)
        result = self.inspect(events, exit_code=1)
        self.assertIs(result['correct'], False)
        self.assertEqual(result['failures'], [failure])

    def test_failed_or_missing_completion_and_spawn_check_reject_workload(self):
        for prefix, replacement in (
            ('done ', None),
            ('done ', 'done result=fail reason=spawn'),
            ('check stage=spawn ', None),
            ('check stage=spawn ', 'check stage=spawn alive=2 expected=3 ok=false'),
        ):
            with self.subTest(prefix=prefix, replacement=replacement):
                self.assertIs(self.inspect(self.changed_events(prefix, replacement))['correct'], False)

    def test_missing_or_mismatched_cadence_samples_reject_workload(self):
        for cadence in (
            None,
            'cadence mean_s=2 min_s=2 max_s=2 target_s=2',
            'cadence samples=2 mean_s=2 min_s=2 max_s=2 target_s=2',
            'cadence samples=4 mean_s=2 min_s=2 max_s=2 target_s=2',
        ):
            with self.subTest(cadence=cadence):
                self.assertIs(self.inspect(self.changed_events('cadence ', cadence))['correct'], False)

    def test_missing_or_failed_world_readback_reject_workload(self):
        for verify in (None, 'verify marks_counter=1 marks_in_world=0 ok=false'):
            with self.subTest(verify=verify):
                result = self.inspect(self.changed_events('verify ', verify))
                self.assertIs(result['correct'], False)

    def test_nonzero_engine_exit_vetoes_complete_action_counters(self):
        result = self.inspect(exit_code=1, validation='停止方式: self-shutdown（退出码 1，运行 2s）\n  结果: FAIL\n')
        self.assertIs(result['correct'], False)
        self.assertEqual(result['engine_exit_code'], 1)

    def test_step_rate_only_failure_preserves_workload_correctness(self):
        events = self.changed_events(
            'stats t=5.0 ', 'stats t=5.0 agents=3/3 stepped_delta=3 steps_per_sec=2 decisions=3',
        )
        result = self.inspect(
            events, exit_code=1,
            validation='  结果: FAIL\n    - steps_per_sec 最低 2.00，低于实时基准 11.1 太多\n',
        )
        self.assertIs(result['correct'], True)
        self.assertIs(result['realtime_pass'], False)
        self.assertEqual(result['exit_code'], 1)
        self.assertEqual(result['failures'], [])
        self.assertEqual(result['steps_per_sec']['min'], 2)

    def test_lossless_compressed_evidence_is_retained_for_success_and_failure(self):
        for passed in (True, False):
            with self.subTest(passed=passed):
                events = self.EVENTS if passed else self.changed_events('verify ', None)
                result = self.inspect(events)
                self.assertIs(result['correct'], passed)
                compressed = Path(str(self.log) + '.gz')
                self.assertTrue(compressed.is_file())
                with gzip.open(compressed, 'rb') as retained:
                    self.assertEqual(retained.read(), self.raw_log)
                self.assertFalse(self.log.exists())
                self.assertFalse(self.event_file.exists())
                self.assertEqual(self.report.read_text(encoding='utf-8'), self.report_header)

    def test_behavior_hash_ignores_timestamps_and_scheduling_measurements(self):
        baseline = self.inspect(label='baseline')
        events = list(self.EVENTS)
        events[0] = 'configuration optimized=true frame_budget_ms=8.0 profile=true'
        events[3] = 'round number=1 wall_ms=300 cpu_ms=1.25'
        events[4] = 'stats t=7.0 agents=3/3 stepped_delta=3 steps_per_sec=10.1 decisions=3'
        events[7] = 'performance elapsed_s=4 decisions_per_sec=1.5 object_queries=2'
        events[8] = 'cadence samples=3 mean_s=3 min_s=2 max_s=4 target_s=2'
        rescheduled = self.inspect(events, label='rescheduled', timestamp='2026-10-28 13:30:00')
        self.assertIs(rescheduled['correct'], True)
        self.assertNotEqual(baseline['round_wall_ms'], rescheduled['round_wall_ms'])
        self.assertRegex(baseline['behavior_sha256'], r'^[0-9a-f]{64}$')
        self.assertEqual(baseline['behavior_sha256'], rescheduled['behavior_sha256'])

    def test_behavior_hash_changes_with_actions_summary_and_world_outcome(self):
        baseline_hash = self.inspect()['behavior_sha256']
        for prefix, replacement in (
            ('ev=mark ', 'ev=mark agent=1 persona=maker at=1,1,0 marks_total=1'),
            ('summary ', 'summary spawned=3 alive=3 decisions=5 rounds=2 marks=1 meetings=0'),
            ('verify ', 'verify marks_counter=1 marks_in_world=0 ok=false'),
        ):
            with self.subTest(prefix=prefix):
                changed = self.inspect(self.changed_events(prefix, replacement))
                self.assertNotEqual(baseline_hash, changed['behavior_sha256'])


if __name__ == '__main__':
    unittest.main()
