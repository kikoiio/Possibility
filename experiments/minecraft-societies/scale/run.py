#!/usr/bin/env python3
"""Run the existing societybench mod sequentially and preserve auditable results."""
import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import statistics
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
MOD = HERE.parent / 'bench' / 'init.lua'
FIELDS = re.compile(r'(\w+)=([^\s]+)')


def analyze(log, count, mode, min_samples):
    records = []
    for line in log.splitlines():
        match = re.search(r'BENCH (forceload|spawn|verify|sample)\s+(.*)', line)
        if match:
            fields = dict(FIELDS.findall(match.group(2)))
            if fields.get('count') == str(count) and fields.get('mode') == mode:
                records.append((match.group(1), fields))
    errors = []
    loads = [f for k, f in records if k == 'forceload']
    if not loads or '/' not in loads[-1].get('ok', '') or len(set(loads[-1]['ok'].split('/'))) != 1:
        errors.append('forceload incomplete or missing')
    spawns = [f for k, f in records if k == 'spawn']
    if not spawns or spawns[-1].get('failed') != '0':
        errors.append('spawn failed or missing')
    verified = False
    samples = []
    for kind, f in records:
        if kind == 'verify':
            verified = f.get('alive') == str(count)
        elif kind == 'sample' and verified:
            if f.get('entities') != str(count) or f.get('stepped') != str(count):
                errors.append('entity count or stepped count mismatch')
            try:
                rate = float(f['steps_per_sec'])
                if not 0 < rate < float('inf'):
                    raise ValueError()
                samples.append(rate)
            except (KeyError, ValueError):
                errors.append('invalid step rate')
    if not verified:
        errors.append('entity verification failed or missing')
    if len(samples) < min_samples:
        errors.append('insufficient verified samples')
    return samples, errors


def run_one(binary, output, count, mode, repeat, seconds, min_samples, threshold):
    tag = f'{mode}_{count}_r{repeat}'
    folder = output / tag
    folder.mkdir()
    world = folder / 'world'
    moddir = world / 'worldmods' / 'societybench'
    moddir.mkdir(parents=True)
    shutil.copyfile(MOD, moddir / 'init.lua')
    conf = folder / 'server.conf'
    conf.write_text(f'''bind_address = 127.0.0.1
port = 30099
mg_name = singlenode
max_users = 64
creative_mode = true
enable_damage = false
dedicated_server_step = 0.09
max_forceloaded_blocks = -1
societybench_count = {count}
societybench_mode = {mode}
''')
    log = folder / 'server.log'
    peak = 0
    early = False
    with (folder / 'console.log').open('w') as console:
        proc = subprocess.Popen([binary, '--config', str(conf), '--world', str(world),
                                 '--gameid', 'minetest_game', '--logfile', str(log)],
                                stdout=console, stderr=subprocess.STDOUT)
        try:
            end = time.monotonic() + seconds
            while time.monotonic() < end:
                if proc.poll() is not None:
                    early = True
                    break
                try:
                    status = Path(f'/proc/{proc.pid}/status').read_text()
                    match = re.search(r'^VmRSS:\s+(\d+)', status, re.M)
                    if match:
                        peak = max(peak, int(match.group(1)))
                except (OSError, ProcessLookupError):
                    pass
                time.sleep(min(1, max(0, end - time.monotonic())))
        finally:
            if proc.poll() is None:
                proc.send_signal(signal.SIGTERM)
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
                early = True
    samples, errors = analyze(log.read_text(errors='replace') if log.exists() else '', count, mode, min_samples)
    if early:
        errors.append(f'server exited early or failed to stop (exit {proc.returncode})')
    if proc.returncode not in (0, -signal.SIGTERM):
        errors.append(f'server exit {proc.returncode}')
    if not peak:
        errors.append('RSS unavailable')
    return {'count': count, 'mode': mode, 'repeat': repeat, 'peak_rss_kib': peak,
            'samples': samples, 'median_steps_per_sec': statistics.median(samples) if samples else None,
            'valid': not errors, 'meets_threshold': (min(samples) >= threshold) if not errors else None,
            'errors': errors, 'directory': tag}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', default='luantiserver')
    parser.add_argument('--output', required=True, help='new output directory; must not already exist')
    parser.add_argument('--counts', default='1,5,10,20,100,1000')
    parser.add_argument('--modes', default='idle,move,perceive')
    parser.add_argument('--seconds', type=int, default=30)
    parser.add_argument('--repeats', type=int, default=1)
    parser.add_argument('--min-samples', type=int, default=2)
    parser.add_argument('--threshold', type=float, default=11.0)
    args = parser.parse_args()
    try:
        counts = [int(x) for x in args.counts.split(',')]
        modes = args.modes.split(',')
        if (not counts or len(set(counts)) != len(counts) or any(x <= 0 or x > 20000 for x in counts)
                or not modes or len(set(modes)) != len(modes) or any(x not in ('idle', 'move', 'perceive') for x in modes)
                or args.seconds < 15 or args.repeats < 1 or args.min_samples < 1 or not 0 < args.threshold < float('inf')):
            raise ValueError()
    except ValueError:
        parser.error('invalid counts, modes, duration, repeats, min-samples or threshold')
    binary = shutil.which(args.binary)
    if not binary:
        parser.error(f'cannot find server: {args.binary}')
    binary = str(Path(binary).resolve())
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    version = subprocess.run([binary, '--version'], capture_output=True, text=True, check=True).stdout.strip()
    metadata = {'version': version, 'binary_sha256': hashlib.sha256(Path(binary).read_bytes()).hexdigest(),
                'mod_sha256': hashlib.sha256(MOD.read_bytes()).hexdigest(), 'platform': platform.platform(),
                'cpu_count': os.cpu_count(), 'seconds': args.seconds, 'repeats': args.repeats,
                'min_samples': args.min_samples, 'threshold_steps_per_sec': args.threshold,
                'counts': counts, 'modes': modes, 'git_sha': os.environ.get('GITHUB_SHA')}
    (output / 'metadata.json').write_text(json.dumps(metadata, indent=2) + '\n')
    rows = []
    try:
        for mode in modes:
            for count in counts:
                for repeat in range(1, args.repeats + 1):
                    print(f'{mode} {count} repeat {repeat}', flush=True)
                    row = run_one(binary, output, count, mode, repeat, args.seconds, args.min_samples, args.threshold)
                    rows.append(row)
                    (output / 'results.json').write_text(json.dumps(rows, indent=2) + '\n')
    finally:
        with (output / 'results.csv').open('w', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=['mode', 'count', 'repeat', 'valid', 'meets_threshold',
                                                     'median_steps_per_sec', 'peak_rss_kib', 'samples', 'errors', 'directory'])
            writer.writeheader()
            writer.writerows(rows)
        lines = ['# Luanti capacity ladder', '', f"Version: `{version.splitlines()[0]}`; threshold: {args.threshold} steps/s.",
                 '', '| Mode | Count | Repeat | Valid | Meets threshold | Median steps/s | Peak RSS KiB | Errors |',
                 '|---|---:|---:|---|---|---:|---:|---|']
        for row in rows:
            lines.append('| {mode} | {count} | {repeat} | {valid} | {meets_threshold} | {median_steps_per_sec} | {peak_rss_kib} | {errors} |'.format(**{**row, 'errors': '; '.join(row['errors'])}))
        (output / 'summary.md').write_text('\n'.join(lines) + '\n')
    return 0 if rows and all(r['valid'] for r in rows) else 1


if __name__ == '__main__':
    sys.exit(main())
