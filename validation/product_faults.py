"""Cloud-CI probes for product checkpoint failure windows.

Each probe uses an independent copy of a stopped, committed product world.
No recovery marker is acknowledged and no failed world is repaired or removed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys

if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine.luanti.recovery_journal import MARKER_FILE
from engine.luanti.world_session import WorldSession


ROOT = Path(__file__).resolve().parents[1]
STAGES = ('after_map', 'after_environment', 'after_agents', 'before_commit', 'after_commit')
SECONDS = 45
RECOVERY_MESSAGE = 'previous launcher session requires recovery'
VOLATILE_FILES = {'private/.runtime.conf', 'private/product.log', 'private/worker.log'}
VOLATILE_DIRECTORIES = ('private/model-spool/', 'private/model-audit/', 'private/control/')


def _require(condition, message):
    if not condition:
        raise RuntimeError(message)


def _write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n', encoding='utf-8')


def _digest(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _snapshot(world, *, include_volatile=False):
    """Stream durable file hashes; mtimes also detect identical checkpoint rewrites."""
    result = {}
    for path in sorted(world.rglob('*')):
        relative = path.relative_to(world).as_posix()
        if not include_volatile and (relative in VOLATILE_FILES or
                                    relative.startswith(VOLATILE_DIRECTORIES)):
            continue
        _require(not path.is_symlink(), 'world contains a symlink: ' + relative)
        if path.is_file():
            metadata = path.stat()
            result[relative] = {'sha256': _digest(path), 'bytes': metadata.st_size,
                                'mtime_ns': metadata.st_mtime_ns}
    return result


def _marker(world, world_id):
    path = world / MARKER_FILE
    _require(path.is_file() and not path.is_symlink(), 'fault did not retain a regular recovery marker')
    value = json.loads(path.read_text(encoding='utf-8'))
    _require(type(value) is dict and set(value) == {'version', 'world_id', 'session_id'} and
             value['version'] == 1 and value['world_id'] == world_id and
             isinstance(value['session_id'], str) and bool(value['session_id']),
             'fault left an invalid recovery marker')
    metadata = path.stat()
    return {'value': value, 'sha256': _digest(path), 'inode': metadata.st_ino,
            'mtime_ns': metadata.st_mtime_ns, 'ctime_ns': metadata.st_ctime_ns}


def _known_good(world):
    _require(not os.path.lexists(world / MARKER_FILE), 'source already requires launcher recovery')
    fields = json.loads((world / 'mod_storage/society').read_text(encoding='utf-8'))
    state = json.loads(fields['product_state'])
    _require(state['phase'] == 'READY' and not state.get('pending') and
             not fields.get('product_active_run'), 'source is not a committed, stopped product world')
    for name in ('agent_state', 'environment_state'):
        _require(bool(fields.get(name)), 'source is missing ' + name)
        json.loads(fields[name])


def _refresh_runtime(world):
    mod = world / 'worldmods/society'
    _require(mod.is_dir(), 'source has no society mod')
    sources = [ROOT / 'engine/luanti/mod/society/init.lua']
    sources.extend(path for path in sorted((ROOT / 'cognition').glob('*.lua'))
                   if path.name != 'test.lua' and not path.name.startswith('test_'))
    installed = {}
    for source in sources:
        target = mod / source.name
        shutil.copy2(source, target)
        installed[source.name] = _digest(target)
    return installed


def run_command(command, log, timeout):
    """One owned process group; timeout cleanup never signals unrelated processes."""
    with log.open('wb') as target:
        child = subprocess.Popen(command, cwd=ROOT, stdout=target, stderr=subprocess.STDOUT,
                                 start_new_session=True)
        try:
            return child.wait(timeout=timeout)
        except BaseException:
            # run_product owns a launcher, engine and worker. Killing only its
            # shell can otherwise strand those descendants after a timeout.
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            finally:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                child.wait()
            raise


def _command(world, stage=None):
    command = ['bash', str(ROOT / 'engine/luanti/run_product.sh'), '--world', str(world),
               '--resume', '--fake-model', '--decisions', '1', '--seconds', str(SECONDS)]
    if stage is not None:
        command.extend(['--fault-stage', stage])
    return command


def _preserve_product_log(world, target):
    log = world / 'private/product.log'
    if log.exists():
        shutil.copy2(log, target)
        # Luanti appends to its logfile. Old success/failure lines must not
        # masquerade as evidence for the next launch.
        log.unlink()


def _contains(path, needle):
    if not path.exists():
        return False
    with path.open(encoding='utf-8', errors='replace') as source:
        return any(needle in line for line in source)


def _probe(world, stage, world_id, case, runner):
    result = {'stage': stage, 'world': str(world), 'ok': False}
    try:
        _preserve_product_log(world, case / 'source.product.log')
        fault_log = case / 'fault.stdout.log'
        result['fault_command'] = _command(world, stage)
        result['fault_exit'] = runner(result['fault_command'], fault_log, SECONDS + 30)
        _preserve_product_log(world, case / 'fault.product.log')
        _require(result['fault_exit'] != 0, 'injected run unexpectedly succeeded')
        injection = 'SOCIETY injected-fault stage=' + stage
        _require(_contains(fault_log, injection) or _contains(case / 'fault.product.log', injection),
                 'run failed without reaching the requested injection stage')
        marker = _marker(world, world_id)
        before = _snapshot(world)
        _write_json(case / 'before-retry.json', before)
        _write_json(case / 'marker-before-retry.json', marker)

        retry_log = case / 'retry.stdout.log'
        result['retry_command'] = _command(world)
        result['retry_exit'] = runner(result['retry_command'], retry_log, SECONDS + 30)
        _preserve_product_log(world, case / 'retry.product.log')
        after = _snapshot(world)
        _write_json(case / 'after-retry.json', after)
        marker_after = _marker(world, world_id)
        _write_json(case / 'marker-after-retry.json', marker_after)
        result['changed_files'] = sorted(key for key in before.keys() | after.keys()
                                         if before.get(key) != after.get(key))
        _require(result['retry_exit'] != 0, 'normal retry unexpectedly succeeded')
        _require(_contains(retry_log, RECOVERY_MESSAGE), 'retry was not blocked by the recovery journal')
        _require(marker == marker_after, 'blocked retry changed the recovery marker')
        _require(not result['changed_files'], 'blocked retry changed durable files: ' +
                 ', '.join(result['changed_files']))
        for path in (retry_log, case / 'retry.product.log'):
            for message in ('SOCIETY product-checkpoint commit ', 'SOCIETY persist agents=',
                            'SOCIETY environment-checkpoint time=', 'SOCIETY long-term-checkpoint records='):
                _require(not _contains(path, message), 'blocked retry wrote a checkpoint')
        result['durable_files'] = len(before)
        result['marker_retained'] = True
        result['ok'] = True
    except Exception as error:
        result['error'] = type(error).__name__ + ': ' + str(error)
    _write_json(case / 'result.json', result)
    return result


def run(source, output, *, runner=None):
    """Run all five stages serially; runner injection supports engine-free fixtures."""
    if runner is None:
        _require(any(os.environ.get(name, '').lower() in ('true', '1')
                     for name in ('CI', 'GITHUB_ACTIONS')),
                 'engine fault probes must run in cloud CI')
        runner = run_command
    source, output = Path(source).resolve(strict=True), Path(output).resolve()
    _require(source.is_dir(), 'source must be a stopped product world directory')
    _require(source != output and source not in output.parents and output not in source.parents,
             'source and output must be separate directories')
    _require(not output.exists(), 'output must be fresh; existing evidence is never overwritten')
    report = {'source': str(source), 'output': str(output), 'ok': False, 'stages': []}
    # Cooperative locking also prevents accidental copying of a live source.
    # The clone locks are independent, even though world identities are copied.
    with WorldSession(source) as session:
        _known_good(source)
        original = _snapshot(source, include_volatile=True)
        output.mkdir(parents=True)
        _write_json(output / 'source-state.json', original)
        try:
            for stage in STAGES:
                case = output / stage
                case.mkdir()
                world = case / 'world'
                shutil.copytree(source, world)
                copied = _snapshot(world, include_volatile=True)
                _require(copied == original, 'world clone differs from stopped source')
                _write_json(case / 'runtime.json', _refresh_runtime(world))
                report['stages'].append(_probe(world, stage, session.world_id, case, runner))
        finally:
            report['source_unchanged'] = original == _snapshot(source, include_volatile=True)
            report['ok'] = (report['source_unchanged'] and len(report['stages']) == len(STAGES) and
                            all(result['ok'] for result in report['stages']))
            _write_json(output / 'report.json', report)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True, help='stopped, committed product world')
    parser.add_argument('--output', type=Path, required=True, help='fresh evidence directory')
    args = parser.parse_args(argv)
    try:
        report = run(args.source, args.output)
    except (OSError, RuntimeError, ValueError, KeyError) as error:
        print('product fault probes: ' + str(error), file=sys.stderr)
        return 1
    print(json.dumps(report, sort_keys=True))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
