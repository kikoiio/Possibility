"""Durable drafts and explicit, crash-recoverable publication to a new WorldStore."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import uuid

from genesis.genesis import GenesisError, public_view, validate
from world.store import WorldStore


class DraftConflict(Exception):
    pass


class DraftCorrupt(Exception):
    pass


def _encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def _check_draft(draft):
    errors = validate(draft)
    if errors:
        raise GenesisError('invalid_draft', errors)
    # Round-trip also guarantees callers cannot mutate the persisted value later.
    try:
        data = _encode(draft)
        data.encode('utf-8')
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise GenesisError('invalid_draft') from None
    if len(data.encode('utf-8')) > 8192:
        raise GenesisError('invalid_draft')
    return data


def _sync_dir(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _projection(draft, draft_id, revision, token):
    public = public_view(draft)
    public.pop('rules')
    # These are origin semantics, not engine geometry or implemented rules.
    world = {'genesis': {'title': public['title'], 'description': public['description'],
                         'places': public['places'], 'layout': public['layout'],
                         'map_applied': False}}
    characters = {actor['id']: {'name': actor['name'], 'role': actor['role'],
                  'goal': actor['goal'], 'place_id': actor['placeId'],
                  'memory_seeds': [m['text'] for m in draft['memories'] if m['actorId'] == actor['id']]}
                  for actor in draft['actors']}
    digest = hashlib.sha256(_encode(draft).encode('utf-8')).hexdigest()
    event = {'id': 'genesis:' + token, 'type': 'genesis.created',
             'data': {'draft_id': draft_id, 'revision': revision, 'draft_sha256': digest}}
    return world, characters, event


def _feedback(draft):
    return [{'code': 'descriptive_rule_not_implemented', 'rule_id': rule['id']} for rule in draft['rules']] + [
        {'code': 'luanti_map_not_integrated'}, {'code': 'character_runtime_not_integrated'}]


class DraftStore:
    """One connection per thread. Explicit creation never opens or resets an existing file."""
    def __init__(self, path, *, create=False):
        self.path = Path(path).absolute()
        if create:
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.close(fd)
        uri = self.path.as_uri() + '?mode=rw'
        self.db = sqlite3.connect(uri, uri=True, isolation_level=None)
        try:
            self.db.execute('PRAGMA synchronous=FULL')
            if create:
                self.db.execute('BEGIN IMMEDIATE')
                self.db.execute('CREATE TABLE drafts (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, target TEXT, token TEXT)')
                self.db.execute('PRAGMA user_version=1')
                self.db.execute('COMMIT')
                _sync_dir(str(self.path.parent))
            else:
                if self.db.execute('PRAGMA user_version').fetchone()[0] != 1 or self.db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                    raise DraftCorrupt('invalid draft store')
                columns = self.db.execute('PRAGMA table_info(drafts)').fetchall()
                if [c[1] for c in columns] != ['id', 'revision', 'payload', 'status', 'target', 'token']:
                    raise DraftCorrupt('invalid draft schema')
        except Exception:
            if self.db.in_transaction: self.db.execute('ROLLBACK')
            self.db.close()
            raise

    def close(self):
        self.db.close()

    def _row(self, draft_id):
        row = self.db.execute('SELECT id,revision,payload,status,target,token FROM drafts WHERE id=?', (draft_id,)).fetchone()
        if row is None: raise KeyError(draft_id)
        ident, rev, payload, status, target, token = row
        try:
            draft = json.loads(payload)
            if (not isinstance(ident, str) or not ident or type(rev) is not int or rev < 1
                or status not in ('draft', 'pending', 'confirmed') or _check_draft(draft) != payload
                or (status == 'draft' and (target is not None or token is not None))
                or (status != 'draft' and (not isinstance(target, str) or not os.path.isabs(target)
                    or not isinstance(token, str) or len(token) != 32 or any(c not in '0123456789abcdef' for c in token)))):
                raise ValueError
        except (ValueError, TypeError, GenesisError, RecursionError):
            raise DraftCorrupt('invalid draft record') from None
        return {'id': ident, 'revision': rev, 'draft': draft, 'status': status, 'target': target, 'token': token}

    def create(self, draft):
        payload = _check_draft(draft)
        ident = uuid.uuid4().hex
        self.db.execute('INSERT INTO drafts VALUES (?, 1, ?, ?, NULL, NULL)', (ident, payload, 'draft'))
        return self.read(ident)

    def read(self, draft_id):
        row = self._row(draft_id)
        return {k: v for k, v in row.items() if k != 'token'}

    def update(self, draft_id, expected_revision, draft):
        payload = _check_draft(draft)
        if type(expected_revision) is not int or not 1 <= expected_revision < 9223372036854775807:
            raise ValueError('invalid revision')
        self.db.execute('BEGIN IMMEDIATE')
        try:
            row = self._row(draft_id)
            if row['status'] != 'draft' or row['revision'] != expected_revision:
                raise DraftConflict('draft changed or confirmation started')
            self.db.execute('UPDATE drafts SET revision=revision+1, payload=? WHERE id=?', (payload, draft_id))
            self.db.execute('COMMIT')
        except Exception:
            if self.db.in_transaction: self.db.execute('ROLLBACK')
            raise
        return self.read(draft_id)

    def confirm(self, draft_id, expected_revision, world_path):
        """Confirm exactly this revision and path; a retry recovers only the same request."""
        if type(expected_revision) is not int or expected_revision < 1:
            raise ValueError('invalid revision')
        target = str(Path(world_path).absolute())
        if not Path(target).parent.is_dir(): raise ValueError('target directory missing')
        self.db.execute('BEGIN IMMEDIATE')
        try:
            row = self._row(draft_id)
            if row['revision'] != expected_revision:
                raise DraftConflict('stale revision')
            if row['status'] == 'draft':
                token = uuid.uuid4().hex
                self.db.execute('UPDATE drafts SET status=?,target=?,token=? WHERE id=?', ('pending', target, token, draft_id))
            elif row['target'] != target:
                raise DraftConflict('confirmation target differs')
            self.db.execute('COMMIT')
        except Exception:
            if self.db.in_transaction: self.db.execute('ROLLBACK')
            raise
        return self.recover_confirmation(draft_id)

    def recover_confirmation(self, draft_id):
        """Resume a previously confirmed request, or verify a completed one."""
        self.db.execute('BEGIN IMMEDIATE')
        try:
            row = self._row(draft_id)
            if row['status'] == 'draft': raise DraftConflict('explicit confirmation required')
            world, characters, event = _projection(row['draft'], row['id'], row['revision'], row['token'])
            target = Path(row['target'])
            if row['status'] == 'confirmed' and not target.exists():
                raise DraftConflict('confirmed world is missing')
            if not target.exists() and not target.is_symlink():
                self._publish(target, world, characters, event)
            self._verify(target, event, world, characters)
            _sync_dir(str(target.parent))
            self.db.execute('UPDATE drafts SET status=? WHERE id=?', ('confirmed', draft_id))
            self.db.execute('COMMIT')
            return {'draft_id': draft_id, 'revision': row['revision'], 'world_path': str(target),
                    'status': 'confirmed', 'unsupported': _feedback(row['draft'])}
        except Exception:
            if self.db.in_transaction: self.db.execute('ROLLBACK')
            raise

    @staticmethod
    def _verify(target, event, world, characters):
        # Never open an unrelated target with WorldStore: its recovery may touch SQLite journals.
        # Read-only inspection first; existing non-owned files are left byte-for-byte untouched.
        if target.is_symlink(): raise DraftConflict('world path already exists')
        try:
            db = sqlite3.connect(target.absolute().as_uri() + '?mode=ro', uri=True)
            try:
                first = db.execute('SELECT event_id, request FROM events WHERE version=1').fetchone()
                if not first or first[0] != event['id']:
                    raise DraftConflict('world path already exists')
                request = json.loads(first[1])
                if (request.get('event') != event or request.get('world') != world
                    or request.get('characters') != characters or request.get('expected_version') != 0
                    or request.get('elapsed') != 0 or request.get('paused') is not None):
                    raise DraftConflict('world origin mismatch')
            finally: db.close()
        except DraftConflict:
            raise
        except (sqlite3.Error, ValueError, TypeError, AttributeError):
            raise DraftConflict('world path already exists or is unreadable') from None
        store = WorldStore(target)
        try:
            state = store.recover()
            if not state['events'] or state['events'][0]['event'] != event:
                raise DraftConflict('world origin mismatch')
        finally: store.close()

    @staticmethod
    def _publish(target, world, characters, event):
        fd, temp = tempfile.mkstemp(prefix='.genesis-', suffix='.sqlite', dir=target.parent)
        os.close(fd)
        try:
            store = WorldStore(temp, create=True)
            try:
                store.commit(event, 0, world, characters)
                store.recover()
            finally: store.close()
            fd = os.open(temp, os.O_RDONLY)
            try: os.fsync(fd)
            finally: os.close(fd)
            try:
                os.link(temp, target)
            except FileExistsError:
                raise DraftConflict('world path already exists') from None
            _sync_dir(str(target.parent))
        finally:
            try: os.unlink(temp)
            except FileNotFoundError: pass
