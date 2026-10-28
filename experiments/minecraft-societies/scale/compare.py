#!/usr/bin/env python3
"""Alternating full engine workloads; stream and retain compressed raw evidence."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import statistics
import subprocess
import time

EXP = Path(__file__).resolve().parents[1]
FIELD = re.compile(r'(\w+)=([^\s]+)')


def distribution(values):
    values = sorted(values)
    return {'n': len(values), 'median': statistics.median(values), 'min': min(values), 'max': max(values)} if values else None


def inspect_run(label, count, decisions, exit_code):
    stem = EXP / 'agent/evidence' / (label + '.run1')
    rates, rounds, active_rounds, performance, summary = [], [], [], {}, {}
    fail, done, checked, stepped, world_ok = [], False, False, [], False
    cadence = {}
    behavior = hashlib.sha256()
    with Path(str(stem)+'.log').open() as stream:
        for line in stream:
            if 'SOCIETY ' not in line:
                continue
            event = line.split('SOCIETY ', 1)[1].strip()
            fields = dict(FIELD.findall(event))
            if event.startswith(('ev=', 'verify ', 'summary ')):
                behavior.update((event+'\n').encode())
            if event.startswith('stats '):
                rates.append(float(fields['steps_per_sec']))
                stepped.append(int(fields['stepped_delta']))
            elif event.startswith('round '):
                rounds.append(float(fields['wall_ms']))
                if 'cpu_ms' in fields:
                    active_rounds.append(float(fields['cpu_ms']))
            elif event.startswith('cadence '):
                cadence = {k: float(v) for k,v in fields.items()}
            elif event.startswith('performance '):
                performance = {k: float(v) for k,v in fields.items()}
            elif event.startswith('summary '):
                summary = fields
            elif event.startswith('fail='):
                fail.append(event)
            elif event.startswith('done '):
                done = fields.get('result') == 'ok'
            elif event.startswith('check stage=spawn '):
                checked = fields.get('ok') == 'true'
            elif event.startswith('verify '):
                world_ok = fields.get('ok') == 'true'
    report = Path(str(stem)+'.report.txt')
    header=[]
    with report.open() as stream:
        for line in stream:
            if line.startswith('--- SOCIETY'): break
            header.append(line)
    header=''.join(header)
    rss=re.search(r'峰值 RSS: (\d+) MiB',header)
    engine_exit=re.search(r'停止方式:.*退出码 (\d+)',header)
    cpu_seconds=re.search(r'引擎 CPU 秒 .*: ([0-9.]+)',header)
    correctness = (done and checked and world_ok and not fail and stepped and min(stepped)==count
                   and int(summary.get('decisions',-1))==count*decisions and int(summary.get('alive',-1))==count
                   and cadence.get('samples')==count*(decisions-1)
                   and (not engine_exit or int(engine_exit[1])==0))
    result = {'label':label,'exit_code':exit_code,'engine_exit_code':int(engine_exit[1]) if engine_exit else None,'correct':bool(correctness),
              'realtime_pass':exit_code==0,'steps_per_sec':distribution(rates),
              'round_wall_ms':distribution(rounds),'round_active_ms':distribution(active_rounds),
              'performance':performance,'cadence':cadence,'summary':summary,'failures':fail,
              'behavior_sha256':behavior.hexdigest(),'peak_engine_rss_mib':int(rss[1]) if rss else None,
              'last_sample_engine_cpu_s':float(cpu_seconds[1]) if cpu_seconds else None}
    report.write_text(header)
    log=Path(str(stem)+'.log')
    with log.open('rb') as source,gzip.open(str(log)+'.gz','wb') as target:
        shutil.copyfileobj(source,target,1024*1024)
    log.unlink()
    Path(str(stem)+'.events').unlink(missing_ok=True)
    return result


def run(count,cognition,optimized,trial,decisions=12,profile=False,budget_ms=25):
    label=f'ci-opt-{count}-{str(cognition).lower()}-{str(optimized).lower()}-{trial}'
    if profile: label+='-profile'
    if budget_ms!=25: label+=f'-budget{budget_ms}'
    args=[str(EXP/'agent/run.sh'),'--label',label,'--agents',str(count),'--decisions',str(decisions),
          '--interval','2','--seconds',str(max(240,decisions*20)),'--set','society_bound=128','--set','society_spacing=2',
          '--set',f'society_cognition={str(cognition).lower()}',
          '--set',f'society_optimized={str(optimized).lower()}',
          '--set',f'society_profile={str(profile).lower()}',
          '--set',f'society_frame_budget_ms={budget_ms}']
    started=time.monotonic()
    result=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
    process_wall=time.monotonic()-started
    print(result.stdout,flush=True)
    evidence_started=time.monotonic()
    parsed=inspect_run(label,count,decisions,result.returncode)
    parsed.update(count=count,cognition=cognition,optimized=optimized,trial=trial,
                  decisions_per_agent=decisions,profile=profile,frame_budget_ms=budget_ms,process_wall_s=process_wall,evidence_processing_s=time.monotonic()-evidence_started)
    return parsed


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--counts',default='1000,5000,10000')
    ap.add_argument('--repeats',type=int,default=5)
    ap.add_argument('--output',type=Path,required=True)
    ap.add_argument('--long-decisions',type=int,default=60)
    ap.add_argument('--long-only',action='store_true')
    ap.add_argument('--tune-budgets',help='optimized+cognition only, comma-separated soft callback budgets in ms')
    args=ap.parse_args()
    args.output.parent.mkdir(parents=True,exist_ok=True)
    runs=[]
    def save():
        equivalence=[]
        for count in sorted({r['count'] for r in runs if not r['profile'] and r['trial']!='long'}):
            for cognition in (False,True):
                group=[r for r in runs if r['count']==count and r['cognition']==cognition and not r['profile'] and r['trial']!='long']
                hashes={r['behavior_sha256'] for r in group}
                equivalence.append({'count':count,'cognition':cognition,'runs':len(group),
                                    'distinct_behavior_hashes':len(hashes),'equal':len(hashes)==1})
        args.output.write_text(json.dumps({'behavior_equivalence':equivalence,'source_sha':os.environ.get('GITHUB_SHA'),
            'runs':runs,'notes':['Engine RSS excludes model workers; no model in capacity runs.',
            'Intervals are targets. Round wall includes yields; round active excludes yields.',
            'Each side alternates within trial on one runner; trial order reverses.',
            'Behavior hashes omit timestamps and scheduling configuration.']},indent=2)+'\n')
    if args.tune_budgets:
        budgets=list(map(int,args.tune_budgets.split(',')))
        if not budgets or any(not 1<=b<=70 for b in budgets): ap.error('budgets must be 1..70 ms')
        for count in map(int,args.counts.split(',')):
            for trial in range(1,args.repeats+1):
                offset=(trial-1)%len(budgets)
                order=budgets[offset:]+budgets[:offset]
                if trial%2==0: order=list(reversed(order))
                for budget in order:
                    runs.append(run(count,True,True,trial,budget_ms=budget)); save()
                    if not runs[-1]['correct']: raise SystemExit('Correctness failure; tuning evidence retained.')
        return
    for count in ([] if args.long_only else map(int,args.counts.split(','))):
        for cognition in (False,True):
            for trial in range(1,args.repeats+1):
                for optimized in ((False,True) if trial%2 else (True,False)):
                    runs.append(run(count,cognition,optimized,trial))
                    save()
                    if not runs[-1]['correct']:
                        raise SystemExit('Correctness failure; evidence saved; stopping this workload.')
    # Longer steady workload, then a separate diagnostic excluded from comparisons.
    if args.long_decisions:
        runs.append(run(10000,True,True,'long',decisions=args.long_decisions)); save()
        runs.append(run(10000,True,True,'diagnostic',profile=True)); save()
    if not all(r['correct'] for r in runs):
        raise SystemExit('Correctness failure')

if __name__=='__main__': main()
