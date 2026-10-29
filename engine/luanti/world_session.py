"""Controlled product-world sessions used by the Luanti launcher.

No engine is started here. Callers remain responsible for authenticating world
identity/storage, authorization, and excluding uncooperative writers (including
players, mods and Luanti processes that do not use WorldLock). An expected UUID
is an equality check, not authentication. WorldLock's trusted-directory,
filesystem, no-fork and non-thread-safe requirements apply throughout access.
"""

import os
from pathlib import Path

from engine.luanti.world_identity import create_world_identity, read_world_identity
from engine.luanti.world_lock import LOCK_FILE, WorldLock


class WorldSession:
    """Hold exclusive cooperative access and expose world_id while entered.

    The directory must already exist. create=True permits creating an identity
    only if none exists and the directory contains only the protocol lock file.
    Existing identities are never replaced, even when create=True. A missing
    identity with expected_world_id is rejected without creating one. Missing,
    corrupt and I/O errors propagate; contention raises BlockingIOError and an
    identity mismatch raises ValueError. Failed entry releases the lock too.

    Instances can be reused sequentially, but are not reentrant or thread-safe.
    A creation error may leave a published identity: recovery follows
    world_identity's inspection/sync contract, never automatic replacement.
    The launcher keeps this session open for the complete Luanti process
    lifetime. Identity authentication, authorization and exclusion of
    uncooperative writes remain the caller's job.
    """

    def __init__(self, world_dir, *, create=False, expected_world_id=None):
        self.world_dir = Path(os.path.abspath(os.fspath(world_dir)))
        self.create = create
        self.expected_world_id = expected_world_id
        self.world_id = None
        self._lock = WorldLock(self.world_dir)

    def __enter__(self):
        # Keep acquisition outside cleanup: a rejected nested entry must not
        # release the outer session's lock.
        self._lock.__enter__()
        try:
            try:
                world_id = read_world_identity(self.world_dir)
            except FileNotFoundError:
                if not self.create:
                    raise
                if self.expected_world_id is not None:
                    raise ValueError('expected world identity is missing') from None
                if any(entry.name != LOCK_FILE for entry in self.world_dir.iterdir()):
                    raise ValueError('cannot create identity in a non-empty world')
                world_id = create_world_identity(self.world_dir)
            if (self.expected_world_id is not None
                    and world_id != self.expected_world_id):
                raise ValueError('world identity does not match expected_world_id')
            self.world_id = world_id
            return self
        except BaseException:
            self._lock.release()
            raise

    def __exit__(self, exc_type, exc_value, traceback):
        self.world_id = None
        self._lock.release()
