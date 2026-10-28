"""Single-owner JSON file spool; request execution is isolated in a child process."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

from bridge import MAX_LINE

NAME = re.compile(r'request-(0|[1-9][0-9]{0,15})\.json\Z')
MAX_ID = 2**53 - 1


def run_bridge(request, stop, timeout):
    child = subprocess.Popen([sys.executable, '-u', str(Path(__file__).with_name('bridge.py'))],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, close_fds=True)
    deadline = time.monotonic() + timeout
    payload = json.dumps(request, separators=(',', ':')) + '\n'
    first = True
    try:
        while True:
            if stop.exists():
                return {'id': request['id'], 'ok': False, 'error': 'stopped'}
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return {'id': request['id'], 'ok': False, 'error': 'timeout'}
            try:
                out, _ = child.communicate(input=payload.encode() if first else None,
                                           timeout=min(0.1, remaining))
                result = json.loads(out)
                if child.returncode != 0 or not isinstance(result, dict) or result.get('id') != request['id'] or type(result.get('ok')) is not bool:
                    raise ValueError
                return result
            except subprocess.TimeoutExpired:
                first = False
            except (ValueError, UnicodeError):
                return {'id': request['id'], 'ok': False, 'error': 'bridge_error'}
    finally:
        if child.poll() is None:
            child.kill()
        child.communicate()


def publish(directory, request_id, result):
    target = directory / f'response-{request_id}.json'
    temporary = directory / ('.response-' + uuid.uuid4().hex + '.tmp')
    try:
        # Exclusive creation and a private mode avoid following an existing symlink.
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as out:
            json.dump(result, out, ensure_ascii=True, separators=(',', ':'))
            out.write('\n')
            out.flush()
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def process_one(directory, path, timeout, runner=run_bridge):
    match = NAME.fullmatch(path.name)
    if not match:
        return False
    request_id = int(match.group(1))
    if request_id > MAX_ID:
        return False
    claimed = directory / f'.processing-{request_id}.json'
    try:
        # One worker per spool; Lua must publish by atomic rename.
        os.rename(path, claimed)
    except FileNotFoundError:
        return False
    try:
        try:
            # Never follow a request symlink into arbitrary files.
            fd = os.open(claimed, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, 'rb') as source:
                raw = source.read(MAX_LINE + 1)
            if len(raw) > MAX_LINE:
                raise ValueError
            request = json.loads(raw)
            if (not isinstance(request, dict) or set(request) != {'id', 'context'}
                    or type(request['id']) is not int or request['id'] != request_id
                    or not isinstance(request['context'], dict)):
                raise ValueError
        except (OSError, ValueError, TypeError, UnicodeError):
            result = {'id': request_id, 'ok': False, 'error': 'invalid_request'}
        else:
            try:
                result = runner(request, directory / 'STOP', timeout)
            except Exception:
                result = {'id': request_id, 'ok': False, 'error': 'bridge_error'}
        publish(directory, request_id, result)
    finally:
        claimed.unlink(missing_ok=True)
    return True


def serve(directory, timeout=30.0, poll_interval=0.1):
    directory = Path(directory)
    if not directory.is_dir() or not 0 < timeout <= 300 or not 0.01 <= poll_interval <= 5:
        raise ValueError('invalid worker configuration')
    stop = directory / 'STOP'
    while not stop.exists():
        for path in sorted(directory.glob('request-*.json')):
            if stop.exists():
                break
            process_one(directory, path, timeout)
        time.sleep(poll_interval)


def main():
    parser = argparse.ArgumentParser(description='Run one local spool worker per private directory')
    parser.add_argument('directory')
    parser.add_argument('--timeout', type=float, default=30.0, help='per request deadline in seconds (0 < t <= 300)')
    parser.add_argument('--poll-interval', type=float, default=0.1)
    args = parser.parse_args()
    try:
        serve(args.directory, args.timeout, args.poll_interval)
    except (OSError, ValueError):
        print('spool worker configuration or I/O failure', file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == '__main__':
    sys.exit(main())
