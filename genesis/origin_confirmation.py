"""Controlled v1 confirmation and crash-recoverable origin creation.

The caller must authenticate and authorize the user, obtain explicit consent for
this exact request, and control both databases, paths, engine and exclusive
access. This module supplies neither authentication nor tamper resistance. Keep
worlds frozen and projection readers isolated until creation/recovery succeeds.
The persisted snapshot contains private data; protect the draft database and its
SQLite sidecars accordingly. Do not replace, copy, or roll back either database.

``confirm`` records an explicit intent; it does not create a world. ``create``
uses only that persisted intent and accepts the same full binding on retries.
Confirmation freezes the draft against DraftStore edits and legacy confirmation,
in both pending and complete phases. There is no unfreeze or cancellation API.
Unexpected changes still fail closed; preserve the operation for recovery.
"""
from pathlib import Path
import os
import sqlite3

from genesis.store import DraftConflict, _encode
from world.origin import _text, draft_sha256, validate_world_id
from world.origin_store import create_origin
from world.store import CorruptStore, _json, _read_json


def _require_empty_world(target):
    """Inspect a quiescent v1 WorldStore without recovery or writes.

    Immutable mode prevents SQLite creating sidecars or recovering a journal.
    Sidecars are rejected rather than ignored: they may contain newer state.
    The caller must prevent concurrent changes throughout this check and use.
    """
    path = Path(target)
    try:
        if any(os.path.lexists(target + suffix) for suffix in ('-journal', '-wal', '-shm')):
            raise DraftConflict('world target has SQLite sidecars')
        db = sqlite3.connect(path.as_uri() + '?mode=ro&immutable=1', uri=True)
        try:
            schema = db.execute("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").fetchall()
            expected = [
                ('table', 'checkpoint', 'CREATE TABLE checkpoint (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, snapshot TEXT NOT NULL)'),
                ('table', 'events', 'CREATE TABLE events (version INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, request TEXT NOT NULL, result TEXT NOT NULL)'),
            ]
            if (schema != expected or db.execute('PRAGMA user_version').fetchone() != (1,)
                    or db.execute('PRAGMA quick_check').fetchall() != [('ok',)]):
                raise DraftConflict('invalid world target')
            checkpoints = db.execute('SELECT singleton,version,snapshot FROM checkpoint').fetchall()
            if (len(checkpoints) != 1 or checkpoints[0][:2] != (1, 0)
                    or _json(_read_json(checkpoints[0][2])) != _json({'world': {}, 'characters': {},
                                                                     'clock': {'time': 0, 'paused': True}})
                    or db.execute('SELECT 1 FROM events LIMIT 1').fetchone() is not None):
                raise DraftConflict('world target is not empty')
        finally:
            db.close()
    except (sqlite3.Error, OSError, ValueError, TypeError, CorruptStore) as exc:
        raise DraftConflict('world target is unreadable or invalid') from exc


class OriginConfirmation:
    """Use a dedicated, open DraftStore connection; one connection per thread.

    The v1 table is independent of the legacy confirmation state. Its committed
    binding freezes the draft through DraftStore; read() still reports the legacy
    status 'draft'. Direct SQL writes bypass this protection and are unsupported.
    SQLite FULL synchronization and durable local filesystems are required.
    """

    def __init__(self, drafts):
        self.drafts = drafts
        self.db = drafts.db
        self.db.execute('''CREATE TABLE IF NOT EXISTS origin_confirmations_v1 (
            operation_id TEXT PRIMARY KEY, world_id TEXT NOT NULL UNIQUE,
            target TEXT NOT NULL UNIQUE, draft_id TEXT NOT NULL,
            revision INTEGER NOT NULL, digest TEXT NOT NULL, payload TEXT NOT NULL,
            phase TEXT NOT NULL CHECK (phase IN ('pending', 'complete'))
        )''')

    @staticmethod
    def _binding(world_id, operation_id, draft_id, revision, target):
        validate_world_id(world_id)
        _text(operation_id)
        _text(draft_id)
        if type(revision) is not int or not 1 <= revision < 9223372036854775807:
            raise ValueError('invalid revision')
        path = Path(target)
        if not path.is_absolute():
            raise ValueError('target must be an absolute path')
        target = str(path.resolve(strict=True))
        if not Path(target).is_file():
            raise ValueError('target must be a file')
        return world_id, operation_id, draft_id, revision, target

    def confirm(self, world_id, operation_id, draft_id, revision, target):
        """Persist the caller's explicit confirmation of the exact revision.

        Never accepts a draft, status, or confirmation record from the caller.
        Identical retries succeed; any changed binding or draft fails closed.
        """
        binding = self._binding(world_id, operation_id, draft_id, revision, target)
        world_id, operation_id, draft_id, revision, target = binding
        if target == str(self.drafts.path.resolve()):
            raise ValueError('target and draft database must differ')
        if os.path.samefile(target, self.drafts.path):
            raise DraftConflict('target and draft database must differ')
        self.db.execute('BEGIN IMMEDIATE')
        try:
            row = self.drafts._row(draft_id)
            if row['revision'] != revision or row['status'] != 'draft':
                raise DraftConflict('draft revision or state changed')
            payload = _encode(row['draft'])
            digest = draft_sha256(row['draft'])
            existing = self.db.execute('SELECT world_id,target,draft_id,revision,digest,payload,phase '
                                       'FROM origin_confirmations_v1 WHERE operation_id=?', (operation_id,)).fetchone()
            expected = (world_id, target, draft_id, revision, digest, payload)
            if existing:
                if existing[:6] != expected or existing[6] not in ('pending', 'complete'):
                    raise DraftConflict('confirmation binding differs')
            else:
                collision = self.db.execute('SELECT 1 FROM origin_confirmations_v1 WHERE world_id=? OR target=? OR draft_id=?',
                                            (world_id, target, draft_id)).fetchone()
                if collision:
                    raise DraftConflict('world, target or draft already bound')
                _require_empty_world(target)
                self.db.execute('INSERT INTO origin_confirmations_v1 VALUES (?,?,?,?,?,?,?,?)',
                                (operation_id, world_id, target, draft_id, revision, digest, payload, 'pending'))
            self.db.execute('COMMIT')
        except Exception:
            if self.db.in_transaction: self.db.execute('ROLLBACK')
            raise
        return {'world_id': world_id, 'operation_id': operation_id, 'draft_id': draft_id,
                'draft_revision': revision, 'draft_sha256': digest, 'target': target}

    def create(self, store, engine, world_id, operation_id, draft_id, revision, target, *, exclusive=False):
        """Create or recover a previously confirmed request; never confirms one.

        A failed call may have committed the world. Retry this same request after
        reopening both stores. A completed request never recreates an empty store.
        The caller must retain exclusive access, including across failures.
        """
        world_id, operation_id, draft_id, revision, target = self._binding(
            world_id, operation_id, draft_id, revision, target)
        db_path = store.db.execute('PRAGMA database_list').fetchone()[2]
        if not db_path or str(Path(db_path).resolve(strict=True)) != target:
            raise DraftConflict('world store target differs')
        self.db.execute('BEGIN IMMEDIATE')
        try:
            saved = self.db.execute('SELECT world_id,target,draft_id,revision,digest,payload,phase '
                                    'FROM origin_confirmations_v1 WHERE operation_id=?', (operation_id,)).fetchone()
            if not saved or saved[:4] != (world_id, target, draft_id, revision):
                raise DraftConflict('confirmation missing or binding differs')
            row = self.drafts._row(draft_id)
            digest, payload, phase = saved[4:]
            if (row['status'] != 'draft' or row['revision'] != revision
                    or _encode(row['draft']) != payload or draft_sha256(row['draft']) != digest
                    or phase not in ('pending', 'complete')):
                raise DraftConflict('confirmed draft changed or record corrupt')
            if phase == 'complete' and store.recover()['version'] == 0:
                raise DraftConflict('completed world is missing its origin')
            ref = {'draft_id': draft_id, 'draft_revision': revision, 'draft_sha256': digest,
                   'operation_id': operation_id, 'status': 'confirmed', 'draft': row['draft']}
            result = create_origin(store, engine, world_id, operation_id, ref, exclusive=exclusive)
            self.db.execute('UPDATE origin_confirmations_v1 SET phase=? WHERE operation_id=?',
                            ('complete', operation_id))
            self.db.execute('COMMIT')
            return result
        except Exception:
            if self.db.in_transaction: self.db.execute('ROLLBACK')
            raise
