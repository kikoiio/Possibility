#!/usr/bin/env python3
"""Compact tables from cloud comparison JSON; raw runs remain authoritative."""
import argparse
import json
from pathlib import Path
import statistics


def span(values, digits=2):
    values=[v for v in values if v is not None]
    if not values:return 'unknown'
    return f'{statistics.median(values):.{digits}f} [{min(values):.{digits}f}–{max(values):.{digits}f}]'


def table(runs):
    lines=['| agents | cognition | optimized | budget ms | runs / correct / realtime | elapsed s | actions/s | minimum step/s | actual gap mean s | RSS MiB |',
           '|---|---|---|---|---|---|---|---|---|---|']
    keys=sorted({(r['count'],r['cognition'],r['optimized'],r.get('frame_budget_ms',25))
                 for r in runs if not r['profile'] and r['trial']!='long'})
    for count,cognition,optimized,budget in keys:
        group=[r for r in runs if (r['count'],r['cognition'],r['optimized'],r.get('frame_budget_ms',25))==(count,cognition,optimized,budget)
               and not r['profile'] and r['trial']!='long']
        lines.append('| '+' | '.join(map(str,[count,str(cognition).lower(),str(optimized).lower(),budget,
            f"{len(group)} / {sum(r['correct'] for r in group)} / {sum(r['realtime_pass'] for r in group)}",
            span([r['performance'].get('elapsed_s') for r in group]),
            span([r['performance'].get('decisions_per_sec') for r in group]),
            span([r['steps_per_sec']['min'] for r in group if r['steps_per_sec']]),
            span([r['cadence'].get('mean_s') for r in group]),span([r['peak_engine_rss_mib'] for r in group],0)]))+' |')
    return '\n'.join(lines)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input',nargs='+',type=Path)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    sources=[]; runs=[]
    for root in args.input:
        paths=[root] if root.is_file() else sorted(root.rglob('comparison.json'))+sorted(root.rglob('budget-tuning.json'))
        for path in paths:
            report=json.loads(path.read_text()); runs.extend(report['runs'])
            sources.append({'path':str(path),'source_sha':report.get('source_sha'),
                            'behavior_equivalence':report.get('behavior_equivalence')})
    if len({r['label'] for r in runs})!=len(runs):
        # Identical configured labels across separate tuning/capacity runs are
        # valid; keep those input groups separate rather than silently combine.
        raise SystemExit('Duplicate labels; generate each independent comparison separately.')
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text('# 完整负载对照\n\n中位数 [最小–最大]；步率列为各运行的区间最低值。耗时从生成完成到决策完成，不含停服持久化；RSS 每秒采样，仅含引擎。\n\n'+table(runs)+'\n')
    args.output.with_suffix('.sources.json').write_text(json.dumps(sources,indent=2)+'\n')

if __name__=='__main__':main()
