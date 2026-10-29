"""Standalone identity-file prototype for a future controlled Luanti integration.

The caller must ensure exclusive access to the real world and authenticate its
storage. Copying or cloning a world copies this identity; neither operation
creates a new one. This module is not wired into the Luanti launcher.

Creation publishes a fully written, synced file without replacing any existing
entry. If an error occurs after publication, creation raises but the identity
may exist: inspect it and use sync_world_identity to finish recovery. Never
remove or replace an existing identity as an automatic retry.
"""
import os
from pathlib import Path
import stat
import tempfile
import uuid


IDENTITY_FILE = 'wispiva-world-id'


def _directory(world_dir):
    # The caller supplies an existing, trusted directory and controls access.
    return Path(world_dir)


def _sync_directory(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def read_world_identity(world_dir):
    """Read a canonical UUID, rejecting links, non-regular files and corruption.

    Missing files and I/O failures propagate as OSError; malformed content
    raises ValueError. A read never creates an identity.
    """
    path = _directory(world_dir) / IDENTITY_FILE
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        return _read_identity_fd(fd)
    finally:
        os.close(fd)


def _read_identity_fd(fd):
    """Validate and read one already-open identity file descriptor."""
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        raise ValueError('identity is not a regular file')
    try:
        data = os.pread(fd, 38, 0)
        value = data.decode('ascii')
        if len(value) != 37 or not value.endswith('\n'):
            raise ValueError
        value = value[:-1]
        if str(uuid.UUID(value)) != value:
            raise ValueError
    except OSError:
        raise
    except (UnicodeError, ValueError):
        raise ValueError('invalid world identity') from None
    return value


def create_world_identity(world_dir):
    """Create and durably publish a fresh UUID; fail if any entry exists.

    Exceptions may leave a published identity, especially after a directory
    sync failure. Recovery requires inspecting it, then syncing it explicitly.
    """
    directory = _directory(world_dir)
    identity = str(uuid.uuid4())
    fd, temporary = tempfile.mkstemp(prefix='.wispiva-world-id-', dir=directory)
    published = False
    operation_error = None
    try:
        with os.fdopen(fd, 'wb') as target:
            target.write((identity + '\n').encode('ascii'))
            target.flush()
            os.fsync(target.fileno())
        os.link(temporary, directory / IDENTITY_FILE, follow_symlinks=False)
        published = True
    except BaseException as error:
        operation_error = error

    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
    except BaseException as error:
        if operation_error is None:
            operation_error = error
        else:
            operation_error.add_note('temporary identity cleanup failed: ' + repr(error))

    if published:
        try:
            _sync_directory(directory)
        except BaseException as error:
            if operation_error is None:
                operation_error = error
            else:
                operation_error.add_note('identity directory sync failed: ' + repr(error))

    if operation_error is not None:
        raise operation_error
    return identity


def sync_world_identity(world_dir):
    """Validate and sync an existing identity after an uncertain create result.

    The caller must keep the world isolated throughout inspection and recovery.
    This does not authenticate the identity or prove which create attempt owns it.
    """
    directory = _directory(world_dir)
    fd = os.open(directory / IDENTITY_FILE, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        value = _read_identity_fd(fd)
        os.fsync(fd)
    finally:
        os.close(fd)
    _sync_directory(directory)
    return value
