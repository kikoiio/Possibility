"""Privacy-safe summaries for model memory task evidence."""
import unittest

from validation.summarize_memory_artifact import summarize


TASKS = ('delayed_recall', 'source_attribution', 'stale_fact',
         'avoiding_known_failure', 'chinese_fragment_recall', 'chinese_explicit_recall')


def artifact(*, include_selection=True):
    records, pairs = [], []
    for task in TASKS:
        for seed in range(3):
            pairs.append({'task': task, 'seed': seed + 1,
                          'fifo_correct': False, 'retrieval_correct': True})
        for strategy in ('fifo', 'retrieval'):
            for seed in range(3):
                row = {'task': task, 'seed': seed + 1, 'strategy': strategy,
                       'correct': strategy == 'retrieval', 'valid_action': True}
                if include_selection:
                    row['memory_evidence_selected'] = strategy == 'retrieval' and seed < 2
                records.append(row)
    by_strategy = {
        strategy: {'requests': 18, 'error_count': 0,
                   'token_audits': {'complete': 18, 'missing': 0, 'invalid': 0},
                   'exact_token_totals': {'input_tokens': 30, 'output_tokens': 15,
                                          'total_tokens': 45}}
        for strategy in ('fifo', 'retrieval')}
    return {'kind': 'memory_tasks', 'fixture': False,
            'evidence_kind': 'actual_configured_model', 'planned_calls': 36,
            'seeds': [1, 2, 3],
            'retries': 0, 'records': records, 'pairs': pairs,
            'by_strategy': by_strategy}


class MemoryArtifactSummaryTests(unittest.TestCase):
    def test_reports_selection_coverage_without_memory_text(self):
        result = summarize(artifact())
        self.assertEqual(result['strategy_results']['retrieval']['memory_evidence_selection'],
                         {'measured': 15, 'selected': 10, 'coverage': 10 / 15})
        self.assertEqual(result['strategy_results']['fifo']['memory_evidence_selection'],
                         {'measured': 15, 'selected': 0, 'coverage': 0})
        self.assertEqual(
            result['per_task']['chinese_fragment_recall']['retrieval']
            ['memory_evidence_selection'],
            {'measured': 3, 'selected': 2, 'coverage': 2 / 3})
        self.assertEqual(result['per_task']['chinese_explicit_recall']['retrieval']['requests'], 3)

    def test_old_artifacts_are_explicitly_unmeasured(self):
        result = summarize(artifact(include_selection=False))
        self.assertEqual(result['strategy_results']['retrieval']['memory_evidence_selection'],
                         {'measured': 0, 'selected': 0, 'coverage': None})

    def test_rejects_non_boolean_selection_flags(self):
        source = artifact()
        source['records'][0]['memory_evidence_selected'] = 1
        with self.assertRaisesRegex(ValueError, 'invalid memory evidence selection flag'):
            summarize(source)


if __name__ == '__main__':
    unittest.main()
