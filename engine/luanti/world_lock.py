"""Controlled integration component for future real Luanti world access.

This module is NOT connected to the Luanti launcher or runtime. Its Unix flock
is advisory: every cooperating accessor must use it for the whole world-access
lifetime. It does not enforce exclusion against an unmodified Luanti process.

The caller supplies an existing trusted world directory (including ancestors)
on a filesystem supporting flock. Never unlink or replace the lock file, even
after a crash: the kernel releases locks when descriptors close, and removing
the file could let two processes lock different inodes. Instances are neither
thread-safe nor reentrant; do not fork while holding a lock.
"""

import errno
import os
from pathlib import Path
import stat

try:
    import fcntl
except ImportError:  # No unsafe file-existence fallback on unsupported platforms.
    fcntl = None


LOCK_FILE = 'wispiva-world.lock'


class WorldLock:
    """Exclusive access guard for one world, independent of world identity."""

    def __init__(self, world_dir):
        # Anchor relative paths now so a later chdir cannot change the world.
        self.path = Path(os.path.abspath(os.fspath(world_dir))) / LOCK_FILE
        self._fd = None

    def acquire(self):
        """Return True on acquisition, False on contention; never wait.

        Other errors propagate, leaving this instance available for retry.
        Symlinks (including dangling links) and non-regular files are rejected.
        Calling acquire on an already held instance raises RuntimeError.
        """
        if self._fd is not None:
            raise RuntimeError('world lock is already acquired')
        if fcntl is None or not hasattr(os, 'O_NOFOLLOW'):
            raise NotImplementedError('world locks require Unix flock and O_NOFOLLOW')

        fd = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW
                     | os.O_NONBLOCK, 0o600)
        try:
            opened = os.fstat(fd)
            if not stat.S_ISREG(opened.st_mode):
                raise ValueError('world lock is not a regular file')
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                if error.errno in (errno.EACCES, errno.EAGAIN):
                    return False
                raise
            # Detect a replacement during acquisition. The trusted-directory
            # contract must also prevent replacements after this check.
            current = os.stat(self.path, follow_symlinks=False)
            if (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino):
                raise OSError(errno.ESTALE, 'world lock path changed', str(self.path))
            self._fd = fd
            fd = None
            return True
        finally:
            if fd is not None:
                os.close(fd)

    def release(self):
        """Release ownership and close the descriptor; safe to call twice.

        The file stays in place. Even if explicit unlock fails, close is still
        attempted and the instance can retry acquisition. I/O errors propagate.
        """
        fd = self._fd
        if fd is None:
            return
        self._fd = None
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)

    def __enter__(self):
        if not self.acquire():
            raise BlockingIOError(errno.EWOULDBLOCK, 'world lock is busy', str(self.path))
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.release()
