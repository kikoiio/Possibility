"""Read-only preparation for a future runtime integration; never starts Luanti."""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path

from .compiler import CompileError, compile_plan
from .store import _projection, DraftStore
from luanti.world.store import WorldStore


class PreflightError(ValueError):
    def __init__(self, code, diagnostics=()):
        super().__init__(code)
        self.code = code
        self.diagnostics = list(diagnostics)


def preflight(store: DraftStore, draft_id: str, revision: int, runtime_world_path):
    """Inspect an explicitly confirmed draft and its origin; cannot authorize a launch.

    The caller must protect both the returned plan and the draft store as private data.
    The target availability check is advisory, not a reservation.
    """
    if type(draft_id) is not str or not draft_id or type(revision) is not int or revision < 1:
        raise PreflightError('invalid_confirmation')
    try:
        target = Path(runtime_world_path)
        if not target.is_absolute() or target.name in ('', '.', '..'):
            raise ValueError
        parent = target.parent.resolve(strict=True)
        if not parent.is_dir(): raise ValueError
        target = parent / target.name
    except (ValueError, TypeError, OSError, RuntimeError):
        raise PreflightError('invalid_runtime_path') from None
    if os.path.lexists(target):
        raise PreflightError('runtime_path_exists')

    store.db.execute('BEGIN')
    try:
        try:
            row = store._row(draft_id)
        except KeyError:
            raise PreflightError('confirmation_not_found') from None
        if row['revision'] != revision or row['status'] != 'confirmed':
            raise PreflightError('confirmation_mismatch')
        try:
            plan = compile_plan(row['draft'])
        except CompileError as error:
            raise PreflightError(error.code, error.diagnostics) from None
        rejected = []
        if row['draft']['rules']:
            rejected.append({'code': 'descriptive_rules_unsupported'})
        if plan['public']['semantic_connections']:
            rejected.append({'code': 'connections_unsupported'})
        if any(place['space'] != 'outdoor' for place in plan['public']['places']):
            rejected.append({'code': 'indoor_terrain_unsupported'})
        if rejected: raise PreflightError('unsupported_draft', rejected)
        world, characters, event = _projection(row['draft'], row['id'], row['revision'], row['token'])
        checkpoint = Path(row['target'])
        if not checkpoint.is_file() or checkpoint.is_symlink():
            raise PreflightError('confirmed_world_missing')
        try:
            # WorldStore.recover itself only reads, but its constructor opens read/write
            # and starts initialization transactions. Supply a read-only connection.
            reader = WorldStore.__new__(WorldStore)
            reader.db = sqlite3.connect(checkpoint.absolute().as_uri() + '?mode=ro', uri=True, isolation_level=None)
            try:
                reader.db.execute('PRAGMA query_only=ON')
                state = reader.recover()
            finally:
                reader.close()
            if state['version'] != 1:
                raise PreflightError('world_already_advanced')
            if (state['events'][0]['event'] != event or state['world'] != world
                or state['characters'] != characters or state['clock'] != {'time': 0, 'paused': True}):
                raise PreflightError('confirmed_world_invalid')
        except PreflightError:
            raise
        except Exception:
            raise PreflightError('confirmed_world_invalid') from None
        store.db.execute('COMMIT')
        return {'draft_id': draft_id, 'revision': revision, 'world_path': str(target),
                'status': 'blocked', 'launchable': False, 'plan': plan,
                'blockers': [{'code': 'cross_store_crash_recovery_unimplemented'},
                             {'code': 'private_actor_runtime_projection_unimplemented'},
                             {'code': 'terrain_and_spawn_safety_unverified'},
                             {'code': 'runtime_world_creation_unimplemented'}]}
    except Exception:
        if store.db.in_transaction: store.db.execute('ROLLBACK')
        raise
