"""Transactional world checkpoint and immutable event store (Python 3)."""
import json
import math
from pathlib import Path
import sqlite3


class StoreError(Exception):
    pass


class Conflict(StoreError):
    pass


class CorruptStore(StoreError):
    pass


def _read_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('duplicate JSON key')
            result[key] = value
        return result

    def constant(_value):
        raise ValueError('non-finite JSON number')

    def finite_float(value):
        number = float(value)
        if not math.isfinite(number):
            raise ValueError('non-finite JSON number')
        return number

    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant,
                          parse_float=finite_float)
    except (ValueError, TypeError, RecursionError) as exc:
        raise CorruptStore('invalid persisted JSON') from exc


def _json(value):
    def check(v):
        if v is None or type(v) in (str, bool, int):
            return
        if type(v) is float and math.isfinite(v):
            return
        if type(v) is list:
            for item in v:
                check(item)
            return
        if type(v) is dict and all(type(k) is str for k in v):
            for item in v.values():
                check(item)
            return
        raise ValueError('values must be finite JSON with string object keys')
    check(value)
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def _object(value, name):
    if type(value) is not dict:
        raise ValueError(name + ' must be an object')
    _json(value)


def _key(value, name):
    if type(value) is not str or not value:
        raise ValueError(name + ' must be a nonempty string')


def _number(value, name):
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
        raise ValueError(name + ' must be a finite nonnegative number')


def _snapshot(world, characters, clock):
    _object(world, 'world')
    _object(characters, 'characters')
    for key, value in characters.items():
        _key(key, 'character key')
        _object(value, 'character snapshot')
    if type(clock) is not dict or set(clock) != {'time', 'paused'} or type(clock['paused']) is not bool:
        raise ValueError('clock must contain time and paused')
    _number(clock['time'], 'time')
    return {'world': world, 'characters': characters, 'clock': clock}


def _validate_result(result, version, event_id):
    if (type(result) is not dict or set(result) != {'version', 'event_id'}
            or type(result['version']) is not int or result['version'] != version
            or type(result['event_id']) is not str or result['event_id'] != event_id):
        raise CorruptStore('invalid event result')


class WorldStore:
    """Single-world SQLite store. Call close() when finished."""
    def __init__(self, path, *, create=False):
        uri = Path(path).absolute().as_uri() + ('?mode=rwc' if create else '?mode=rw')
        self.db = sqlite3.connect(uri, uri=True, isolation_level=None)
        try:
            self.db.execute('PRAGMA foreign_keys=ON')
            self.db.execute('PRAGMA synchronous=FULL')
            self.db.execute('BEGIN IMMEDIATE')
            tables = self.db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall()
            if not tables and not create:
                raise CorruptStore('empty store; explicit creation required')
            if not tables:
                self.db.execute('CREATE TABLE checkpoint (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, snapshot TEXT NOT NULL)')
                self.db.execute('CREATE TABLE events (version INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, request TEXT NOT NULL, result TEXT NOT NULL)')
                initial = _json(_snapshot({}, {}, {'time': 0, 'paused': True}))
                self.db.execute('INSERT INTO checkpoint VALUES (1, 0, ?)', (initial,))
                self.db.execute('PRAGMA user_version=1')
            self.db.execute('COMMIT')
            self.recover()
        except Exception:
            if self.db.in_transaction:
                self.db.execute('ROLLBACK')
            self.db.close()
            raise

    def close(self):
        self.db.close()

    def recover(self):
        """Return a validated, consistent snapshot and event history or fail closed."""
        try:
            self.db.execute('BEGIN')
            if self.db.execute('PRAGMA user_version').fetchone()[0] != 1:
                raise ValueError('unsupported schema version')
            if self.db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise ValueError('SQLite integrity check failed')
            rows = self.db.execute('SELECT singleton, version, snapshot FROM checkpoint').fetchall()
            if len(rows) != 1 or rows[0][0] != 1:
                raise ValueError('invalid checkpoint')
            _, version, raw = rows[0]
            if type(version) is not int or version < 0:
                raise ValueError('invalid version')
            state = _read_json(raw)
            if type(state) is not dict or set(state) != {'world', 'characters', 'clock'}:
                raise ValueError('invalid snapshot fields')
            _snapshot(state['world'], state['characters'], state['clock'])
            events = []
            replay = _snapshot({}, {}, {'time': 0, 'paused': True})
            for seq, event_id, request_raw, result_raw in self.db.execute('SELECT version, event_id, request, result FROM events ORDER BY version'):
                if seq != len(events) + 1:
                    raise ValueError('event sequence gap')
                request, result = _read_json(request_raw), _read_json(result_raw)
                _validate_request(request)
                if request['event']['id'] != event_id or request['expected_version'] != seq - 1:
                    raise ValueError('event identity or version mismatch')
                _validate_result(result, seq, event_id)
                clock = replay['clock']
                if clock['paused'] and request['elapsed'] != 0:
                    raise ValueError('time advanced while paused')
                clock = {'time': clock['time'] + request['elapsed'], 'paused': clock['paused'] if request['paused'] is None else request['paused']}
                replay = _snapshot(request['world'], request['characters'], clock)
                events.append({'version': seq, 'event': request['event']})
            if version != len(events) or _json(state) != _json(replay):
                raise ValueError('checkpoint and events disagree')
            self.db.execute('COMMIT')
            return {'version': version, **state, 'events': events}
        except (sqlite3.Error, ValueError, TypeError, KeyError, OverflowError, CorruptStore) as exc:
            if self.db.in_transaction:
                self.db.execute('ROLLBACK')
            raise CorruptStore('recovery refused: ' + str(exc)) from exc

    def commit(self, event, expected_version, world, characters, *, elapsed=0, paused=None):
        """Atomically commit one event and full replacement snapshots."""
        request = {'event': event, 'expected_version': expected_version, 'world': world,
                   'characters': characters, 'elapsed': elapsed, 'paused': paused}
        _validate_request(request)
        encoded = _json(request)
        try:
            self.db.execute('BEGIN IMMEDIATE')
            row = self.db.execute('SELECT version, request, result FROM events WHERE event_id=?', (event['id'],)).fetchone()
            if row:
                version, request_raw, result_raw = row
                _read_json(request_raw)
                result = _read_json(result_raw)
                _validate_result(result, version, event['id'])
                if request_raw != encoded:
                    raise Conflict('event id already used for a different request')
                self.db.execute('COMMIT')
                return result
            row = self.db.execute('SELECT version, snapshot FROM checkpoint WHERE singleton=1').fetchone()
            if row is None:
                raise CorruptStore('missing checkpoint')
            version, raw = row
            if version != expected_version:
                raise Conflict('stale version')
            state = _read_json(raw)
            clock = state['clock']
            if clock['paused'] and elapsed != 0:
                raise Conflict('cannot advance while paused')
            clock = {'time': clock['time'] + elapsed, 'paused': clock['paused'] if paused is None else paused}
            snapshot = _json(_snapshot(world, characters, clock))
            result = {'version': version + 1, 'event_id': event['id']}
            self.db.execute('INSERT INTO events VALUES (?, ?, ?, ?)', (version + 1, event['id'], encoded, _json(result)))
            self.db.execute('UPDATE checkpoint SET version=?, snapshot=? WHERE singleton=1', (version + 1, snapshot))
            self.db.execute('COMMIT')
            return result
        except Exception:
            if self.db.in_transaction:
                self.db.execute('ROLLBACK')
            raise


def _validate_request(request):
    if type(request) is not dict or set(request) != {'event', 'expected_version', 'world', 'characters', 'elapsed', 'paused'}:
        raise ValueError('invalid request fields')
    event = request['event']
    if type(event) is not dict or set(event) != {'id', 'type', 'data'}:
        raise ValueError('event requires id, type and data')
    _key(event['id'], 'event id')
    _key(event['type'], 'event type')
    _object(event['data'], 'event data')
    version = request['expected_version']
    if type(version) is not int or version < 0 or version >= 9223372036854775807:
        raise ValueError('invalid expected_version')
    _snapshot(request['world'], request['characters'], {'time': 0, 'paused': True})
    _number(request['elapsed'], 'elapsed')
    if request['paused'] is not None and type(request['paused']) is not bool:
        raise ValueError('paused must be boolean or None')
