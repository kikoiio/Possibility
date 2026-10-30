"""Local cooperative product control; no engine launch or world-state writes.

The caller supplies a trusted world directory. Cooperating clients hold the
private/control/.lock flock throughout a request; the runtime must publish a
complete response atomically and echo the request UUID. Never replace or
unlink .lock. A timeout does not prove that the command was not executed;
query status before retrying. Late/foreign files are preserved and block new
requests until inspected. This is not a durable exactly-once command queue.
Both directories and files must belong to the caller and have no group/other
permissions (normally 0700 directories, 0600 files). A private parent directory
does not waive the file-mode check. The runtime wrapper must enforce its umask;
the CLI never chmods or repairs an existing response or lock.
"""
import argparse
import errno
import fcntl
import json
import math
import os
from pathlib import Path
import re
import stat
import tempfile
import time
import uuid


MAX_JSON = 16384
COMMANDS = frozenset({'pause', 'resume', 'speed', 'status'})


class ControlError(Exception):
    """Fixed local error code, without paths, request content or OS details."""


def _finite(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def _private_stat(info, directory=False):
    correct_type = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not correct_type or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ControlError('unsafe_control_path')


def _directory(world):
    root = Path(world).absolute()
    if root.is_symlink() or not root.is_dir():
        raise ControlError('invalid_world')
    directory = root
    for part in ('private', 'control'):
        directory = directory / part
        try:
            directory.mkdir(mode=0o700)
        except FileExistsError:
            pass
        _private_stat(directory.lstat(), directory=True)
    return directory


def _read(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        _private_stat(info)
        with os.fdopen(fd, 'rb', closefd=False) as handle:
            raw = handle.read(MAX_JSON + 1)
        if len(raw) > MAX_JSON:
            raise ControlError('invalid_response')
        def unique(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError
                result[key] = value
            return result
        try:
            data = json.loads(raw, object_pairs_hook=unique,
                              parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        except (ValueError, UnicodeError, RecursionError):
            raise ControlError('invalid_response') from None
        return data, info
    finally:
        os.close(fd)


def _remove_owned(path, identity):
    try:
        data, opened = _read(path)
        current = path.lstat()
        if (type(data) is dict and data.get('id') == identity
                and (current.st_dev, current.st_ino) == (opened.st_dev, opened.st_ino)):
            path.unlink()
    except (OSError, ControlError):
        pass  # Preserve unreadable, malformed, foreign or replaced files.


def _publish(directory, request):
    fd, name = tempfile.mkstemp(prefix='.request-', dir=directory)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            json.dump(request, handle, separators=(',', ':'), allow_nan=False)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.link(name, directory / 'request.json', follow_symlinks=False)
    except FileExistsError:
        raise ControlError('control_busy') from None
    finally:
        os.unlink(name)  # Only the mkstemp file created by this call.


def _response(value, identity):
    if (type(value) is not dict or not {'id', 'ok', 'status'} <= value.keys()
            or not value.keys() <= {'id', 'ok', 'status', 'error'}):
        raise ControlError('invalid_response')
    if value['id'] != identity:
        raise ControlError('response_conflict')
    if type(value['ok']) is not bool:
        raise ControlError('invalid_response')
    status = value['status']
    if type(status) is not dict or set(status) != {'logical_time', 'rate', 'paused', 'pending_models'}:
        raise ControlError('invalid_response')
    for key in ('logical_time', 'pending_models'):
        number = status[key]
        if not _finite(number) or number < 0 or int(number) != number:
            raise ControlError('invalid_response')
    if (not _finite(status['rate']) or not 0 <= status['rate'] <= 1000
            or type(status['paused']) is not bool):
        raise ControlError('invalid_response')
    if 'error' in value and (not isinstance(value['error'], str)
            or re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', value['error']) is None):
        raise ControlError('invalid_response')
    return value


def send_command(world, command, *, rate=None, timeout=15):
    """Wait for a UUID-matched response. Errors expose only fixed safe codes."""
    if not isinstance(command, str) or command not in COMMANDS:
        raise ControlError('invalid_command')
    if not _finite(timeout) or not 0 < timeout <= 300:
        raise ControlError('invalid_timeout')
    if command == 'speed':
        if not _finite(rate) or not 0 <= rate <= 1000:
            raise ControlError('invalid_rate')
    elif rate is not None:
        raise ControlError('unexpected_rate')
    lock_fd = None
    published = False
    identity = str(uuid.uuid4())
    try:
        directory = _directory(world)
        request_path, response_path = directory / 'request.json', directory / 'response.json'
        lock_path = directory / '.lock'
        lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        _private_stat(os.fstat(lock_fd))
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            if exc.errno in (errno.EAGAIN, errno.EACCES):
                raise ControlError('control_busy') from None
            raise
        for path in (request_path, response_path):
            if os.path.lexists(path):
                raise ControlError('control_busy')
        request = {'id': identity, 'command': command}
        if command == 'speed':
            request['rate'] = rate
        _publish(directory, request)
        published = True
        deadline = time.monotonic() + timeout
        while True:
            try:
                value, _ = _read(response_path)
            except FileNotFoundError:
                value = None
            else:
                return _response(value, identity)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ControlError('control_timeout')
            time.sleep(min(0.05, remaining))
    except OSError:
        raise ControlError('control_io_error') from None
    finally:
        if published:
            _remove_owned(request_path, identity)
            _remove_owned(response_path, identity)
        if lock_fd is not None:
            os.close(lock_fd)  # Closing releases flock; .lock remains in place.


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--world', required=True)
    parser.add_argument('--command', required=True, choices=sorted(COMMANDS))
    parser.add_argument('--rate', type=float)
    parser.add_argument('--timeout', type=float, default=15)
    args = parser.parse_args(argv)
    try:
        result = send_command(args.world, args.command, rate=args.rate, timeout=args.timeout)
    except ControlError as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}))
        return 1
    print(json.dumps(result, allow_nan=False))
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
