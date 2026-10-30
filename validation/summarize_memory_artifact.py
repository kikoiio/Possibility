"""Reduce a completed memory-evaluation artifact to privacy-safe metrics."""
from __future__ import annotations

import argparse
import json
from pathlib import Path


TASKS = {
    'delayed_recall', 'source_attribution', 'stale_fact',
    'avoiding_known_failure', 'chinese_fragment_recall',
}
STRATEGIES = ('fifo', 'retrieval')
SCORE_CATEGORIES = (
    'correct', 'abstained', 'wrong_source_target', 'stale_fact_used',
    'known_failure_repeated', 'wrong_target', 'wrong_action', 'wrong_answer', 'unscored',
)


def summarize(source: dict) -> dict:
    if (source.get('kind') != 'memory_tasks' or source.get('fixture') is not False
            or source.get('evidence_kind') != 'actual_configured_model'
            or source.get('planned_calls') != 30 or source.get('retries') != 0):
        raise ValueError('unexpected or synthetic memory artifact')
    records = source.get('records')
    pairs = source.get('pairs')
    if not isinstance(records, list) or len(records) != 30:
        raise ValueError('incomplete task records')
    if not isinstance(pairs, list) or len(pairs) != 15:
        raise ValueError('incomplete paired results')

    strategy_summary = {}
    by_task = {}
    for strategy in STRATEGIES:
        rows = [row for row in records if row.get('strategy') == strategy]
        if len(rows) != 15 or any(row.get('task') not in TASKS for row in rows):
            raise ValueError('invalid strategy records')
        if any(type(row.get('correct')) is not bool or type(row.get('valid_action')) is not bool
               for row in rows):
            raise ValueError('invalid result flags')
        source_summary = source.get('by_strategy', {}).get(strategy, {})
        exact_tokens = source_summary.get('exact_token_totals')
        if (source_summary.get('requests') != len(rows)
                or source_summary.get('error_count') != 0
                or source_summary.get('token_audits') != {'complete': len(rows), 'missing': 0, 'invalid': 0}
                or not isinstance(exact_tokens, dict)
                or any(type(exact_tokens.get(k)) is not int or exact_tokens[k] < 0
                       for k in ('input_tokens', 'output_tokens', 'total_tokens'))
                or exact_tokens['total_tokens'] != exact_tokens['input_tokens'] + exact_tokens['output_tokens']):
            raise ValueError('incomplete provider audit')
        correct = sum(row['correct'] for row in rows)
        selection = selection_coverage(rows)
        strategy_summary[strategy] = {
            'requests': len(rows),
            'correct': correct,
            'accuracy': correct / len(rows),
            'valid_actions': sum(row['valid_action'] for row in rows),
            'provider_errors': source_summary['error_count'],
            'score_categories': source_summary.get('score_categories'),
            'score_flags': source_summary.get('score_flags'),
            'memory_evidence_selection': selection,
            'exact_provider_tokens': exact_tokens,
        }

    for task in sorted(TASKS):
        task_rows = {strategy: [row for row in records
                                if row.get('task') == task and row.get('strategy') == strategy]
                     for strategy in STRATEGIES}
        if any(len(rows) != 3 for rows in task_rows.values()):
            raise ValueError('task/strategy coverage is incomplete')
        by_task[task] = {
            strategy: {'correct': sum(row['correct'] for row in rows), 'requests': len(rows),
                       'accuracy': sum(row['correct'] for row in rows) / len(rows),
                       'memory_evidence_selection': selection_coverage(rows)}
            for strategy, rows in task_rows.items()
        }

    outcomes = {'retrieval_wins': 0, 'ties': 0, 'fifo_wins': 0}
    paired_tasks = set()
    for pair in pairs:
        task, seed = pair.get('task'), pair.get('seed')
        if task not in TASKS or type(seed) is not int:
            raise ValueError('invalid paired record')
        key = (task, seed)
        if key in paired_tasks:
            raise ValueError('duplicate paired record')
        paired_tasks.add(key)
        fifo, retrieval = pair.get('fifo_correct'), pair.get('retrieval_correct')
        if type(fifo) is not bool or type(retrieval) is not bool:
            raise ValueError('invalid paired scores')
        if retrieval and not fifo:
            outcomes['retrieval_wins'] += 1
        elif fifo and not retrieval:
            outcomes['fifo_wins'] += 1
        else:
            outcomes['ties'] += 1
    if len(paired_tasks) != 15:
        raise ValueError('paired coverage is incomplete')

    return {
        'schema_version': 1,
        'evidence_kind': source['evidence_kind'],
        'source_sha256': source.get('source_sha256'),
        'model_sha256': source.get('model_sha256'),
        'planned_calls': source['planned_calls'],
        'tasks': len(TASKS),
        'seeds': source.get('seeds'),
        'strategy_results': strategy_summary,
        'per_task': by_task,
        'paired_outcomes': {'pairs': len(pairs), **outcomes},
        'interpretation_limit': (
            'Three paired seeds per synthetic task are exploratory; exact-message scoring '
            'does not establish long-term memory quality in a live world.'
        ),
    }


def selection_coverage(rows: list[dict]) -> dict:
    """Summarize answer-evidence presence without exposing memory contents.

    Historical artifacts predate this diagnostic and remain valid; their
    selection coverage is explicitly unmeasured.
    """
    measured = [row['memory_evidence_selected'] for row in rows
                if 'memory_evidence_selected' in row]
    if any(type(value) is not bool for value in measured):
        raise ValueError('invalid memory evidence selection flag')
    selected = sum(measured)
    return {'measured': len(measured), 'selected': selected,
            'coverage': selected / len(measured) if measured else None}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    source = json.loads(args.source.read_text(encoding='utf-8'))
    result = summarize(source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + '\n', encoding='utf-8')
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
