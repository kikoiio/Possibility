"""Durable launcher-session marker for fail-closed power-loss recovery.

The marker is deliberately narrower than a world checkpoint.  It records only
that a cooperative launcher session was active.  If the launcher is killed
before normal cleanup, the next launch refuses to enter until a caller has
performed its own world/checkpoint reconciliation and explicitly acknowledges
the marker.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import stat
import tempfile
import uuid


MARKER_FILE = 'wispiva-session-recovery.json'


class RecoveryRequired(RuntimeError):
    """A prior launcher session ended without durable normal cleanup."""


def _directory(world_dir) -> Path:
    return Path(os.path.abspath(os.fspath(world_dir)))


def _sync_directory(directory: Path) -> None:
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _read(path: Path) -> dict:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise RecoveryRequired('invalid recovery marker')
            raw = os.read(fd, 4097)
        finally:
            os.close(fd)
    except OSError as error:
        raise RecoveryRequired('cannot read recovery marker') from error
    if len(raw) > 4096:
        raise RecoveryRequired('invalid recovery marker')
    try:
        value = json.loads(raw.decode('utf-8'))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise RecoveryRequired('invalid recovery marker') from error
    if (type(value) is not dict or set(value) != {'version', 'world_id', 'session_id'}
            or value['version'] != 1
            or type(value['world_id']) is not str or not value['world_id']
            or type(value['session_id']) is not str or not value['session_id']):
        raise RecoveryRequired('invalid recovery marker')
    return value


class SessionJournal:
    """Publish and clear one durable marker while WorldLock is held."""

    def __init__(self, world_dir, world_id):
        self.directory = _directory(world_dir)
        self.path = self.directory / MARKER_FILE
        self.world_id = world_id
        self.session_id = None

    def begin(self) -> str:
        if self.session_id is not None:
            raise RuntimeError('session journal is already active')
        if self.path.exists():
            marker = _read(self.path)
            if marker['world_id'] != self.world_id:
                raise RecoveryRequired('recovery marker belongs to another world')
            raise RecoveryRequired('previous launcher session requires recovery')

        session_id = str(uuid.uuid4())
        payload = json.dumps({'version': 1, 'world_id': self.world_id,
                              'session_id': session_id},
                             ensure_ascii=True, sort_keys=True, separators=(',', ':')).encode('ascii')
        fd, temporary = tempfile.mkstemp(prefix='.wispiva-session-', dir=self.directory)
        published = False
        try:
            with os.fdopen(fd, 'wb') as target:
                target.write(payload)
                target.flush()
                os.fsync(target.fileno())
            # Link publication refuses to replace a marker created by another
            # cooperating process, even if the directory lock was misused.
            os.link(temporary, self.path, follow_symlinks=False)
            published = True
        except FileExistsError as error:
            raise RecoveryRequired('previous launcher session requires recovery') from error
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
        if not published:
            raise RecoveryRequired('session marker was not published')
        try:
            _sync_directory(self.directory)
        except BaseException:
            # Leave the marker in place. An uncertain directory sync must
            # remain visible to the next opener.
            raise
        self.session_id = session_id
        return session_id

    def finish(self) -> None:
        if self.session_id is None:
            return
        marker = _read(self.path)
        if marker['world_id'] != self.world_id or marker['session_id'] != self.session_id:
            raise RecoveryRequired('session marker changed while active')
        os.unlink(self.path)
        try:
            _sync_directory(self.directory)
        finally:
            self.session_id = None

    @classmethod
    def acknowledge(cls, world_dir, world_id) -> str | None:
        """Clear a stale marker after the caller has reconciled world state."""
        directory = _directory(world_dir)
        path = directory / MARKER_FILE
        if not os.path.lexists(path):
            return None
        marker = _read(path)
        if marker['world_id'] != world_id:
            raise RecoveryRequired('recovery marker belongs to another world')
        os.unlink(path)
        _sync_directory(directory)
        return marker['session_id']
