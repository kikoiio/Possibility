"""Small filesystem/mocked-runtime checks; no Luanti, GUI, network or sleeps."""
import contextlib
import fcntl
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

from engine.luanti import control


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.world = Path(self.tmp.name)
        self.directory = control._directory(self.world)
        self.request = self.directory / 'request.json'
        self.response = self.directory / 'response.json'
        self.now = 0.0

    def write(self, path, value):
        with path.open('w') as handle:
            json.dump(value, handle)
        path.chmod(0o600)

    def reply(self, request, **changes):
        value = {'id': request['id'], 'ok': True,
                 'status': {'logical_time': 42, 'rate': 24,
                            'paused': False, 'pending_models': 2}}
        value.update(changes)
        self.write(self.response, value)
        return value

    def run_command(self, command='status', handler=None, **kwargs):
        def sleep(interval):
            self.now += interval
            if handler:
                handler(json.loads(self.request.read_text()))
        with patch.object(control.time, 'monotonic', side_effect=lambda: self.now), \
                patch.object(control.time, 'sleep', side_effect=sleep):
            return control.send_command(self.world, command, **kwargs)

    def test_round_trip_all_commands_exact_payload_private_files(self):
        for command, rate in (('pause', None), ('resume', None), ('status', None),
                              ('speed', 0), ('speed', 1000), ('speed', 0.5)):
            with self.subTest(command=command, rate=rate):
                def respond(request):
                    self.assertEqual(str(uuid.UUID(request['id'])), request['id'])
                    self.assertEqual(request['command'], command)
                    self.assertEqual(set(request), {'id', 'command', 'rate'} if rate is not None
                                     else {'id', 'command'})
                    if rate is not None:
                        self.assertEqual(request['rate'], rate)
                    self.assertEqual(self.request.stat().st_mode & 0o777, 0o600)
                    self.reply(request)
                    self.assertEqual(self.response.stat().st_mode & 0o777, 0o600)
                result = self.run_command(command, respond, rate=rate)
                self.assertTrue(result['ok'])
                self.assertFalse(self.request.exists())
                self.assertFalse(self.response.exists())
                self.assertEqual(list(self.directory.iterdir()), [self.directory / '.lock'])
        self.assertEqual(self.directory.stat().st_mode & 0o777, 0o700)

    def test_timeout_bounded_cleanup_and_lock_release(self):
        with self.assertRaisesRegex(control.ControlError, '^control_timeout$'):
            self.run_command(timeout=0.1)
        self.assertLessEqual(self.now, 0.11)
        self.assertFalse(self.request.exists())
        self.assertTrue(self.run_command(handler=self.reply)['ok'])

    def test_consumed_request_is_not_republished(self):
        def respond(request):
            self.request.unlink()  # Runtime consumes before returning a response.
            self.reply(request)
        self.assertTrue(self.run_command(handler=respond)['ok'])
        self.assertFalse(self.request.exists())
        self.assertFalse(self.response.exists())

    def test_malformed_response_is_preserved_without_leaking_content(self):
        for raw in (b'{secret', b'{"id":"a","id":"b"}', b'[' * 1500,
                    b'x' * (control.MAX_JSON + 1)):
            with self.subTest(length=len(raw)):
                def respond(request):
                    self.response.write_bytes(raw)
                    self.response.chmod(0o600)
                with self.assertRaisesRegex(control.ControlError, '^invalid_response$'):
                    self.run_command(handler=respond)
                self.assertFalse(self.request.exists())
                self.assertEqual(self.response.read_bytes(), raw)
                self.response.unlink()

    def test_foreign_pending_data_is_never_removed(self):
        for path in (self.request, self.response):
            with self.subTest(path=path.name):
                self.write(path, {'id': str(uuid.uuid4()), 'note': 'keep'})
                before = path.read_bytes()
                with self.assertRaisesRegex(control.ControlError, '^control_busy$'):
                    self.run_command(handler=self.reply)
                self.assertEqual(path.read_bytes(), before)
                path.unlink()  # Fixture cleanup, not client behavior.

    def test_replaced_and_foreign_files_during_wait_preserved(self):
        foreign = str(uuid.uuid4())
        def respond(request):
            self.write(self.request, {'id': foreign, 'command': 'pause'})
            self.reply(request, id=foreign)
        with self.assertRaisesRegex(control.ControlError, '^response_conflict$'):
            self.run_command(handler=respond)
        self.assertEqual(json.loads(self.request.read_text())['id'], foreign)
        self.assertEqual(json.loads(self.response.read_text())['id'], foreign)

    def test_lock_contention_and_inode_preserved(self):
        path = self.directory / '.lock'
        fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            inode = path.stat().st_ino
            with self.assertRaisesRegex(control.ControlError, '^control_busy$'):
                self.run_command(handler=self.reply)
            self.assertFalse(self.request.exists())
            self.assertEqual(path.stat().st_ino, inode)
        finally:
            os.close(fd)
        self.assertTrue(self.run_command(handler=self.reply)['ok'])
        self.assertEqual(path.stat().st_ino, inode)

    def test_atomic_publish_does_not_overwrite_racing_request(self):
        link = os.link
        def race(source, destination, **kwargs):
            self.write(Path(destination), {'id': 'foreign'})
            return link(source, destination, **kwargs)
        with patch.object(control.os, 'link', side_effect=race):
            with self.assertRaisesRegex(control.ControlError, '^control_busy$'):
                self.run_command()
        self.assertEqual(json.loads(self.request.read_text()), {'id': 'foreign'})
        self.assertFalse(list(self.directory.glob('.request-*')))

    def test_input_validation_has_no_publication(self):
        cases = [dict(command='other'), dict(command=None), dict(command=[]),
                 dict(command='pause', rate=24), dict(command='speed'),
                 dict(command='speed', rate=True)]
        for value in (-1, 1001, float('nan'), float('inf'), '24'):
            cases.append(dict(command='speed', rate=value))
        for value in (0, -1, 301, True, float('nan'), float('inf'), '15'):
            cases.append(dict(command='status', timeout=value))
        for values in cases:
            with self.subTest(values=values), self.assertRaises(control.ControlError):
                control.send_command(self.world, **values)
            self.assertFalse(self.request.exists())

    def test_malformed_response_status_and_safe_error_validation(self):
        for changes in ({'ok': 1}, {'status': {}}, {'extra': True},
                        {'error': '/private/path: raw provider text'},
                        {'status': {'logical_time': -1, 'rate': 24,
                                    'paused': False, 'pending_models': 0}}):
            with self.subTest(changes=changes):
                with self.assertRaisesRegex(control.ControlError, '^invalid_response$'):
                    self.run_command(handler=lambda req: self.reply(req, **changes))
                self.assertFalse(self.request.exists())
                self.assertFalse(self.response.exists())
        result = self.run_command(handler=lambda req: self.reply(req, ok=False, error='world_frozen'))
        self.assertFalse(result['ok'])
        self.assertEqual(result['error'], 'world_frozen')

    def test_status_numbers_and_pause_are_checked(self):
        base = {'logical_time': 42, 'rate': 24, 'paused': False, 'pending_models': 0}
        for field, value in (('logical_time', True), ('logical_time', 0.5),
                             ('rate', float('inf')), ('rate', -1), ('rate', 1001),
                             ('paused', 0), ('pending_models', -1), ('pending_models', 0.5)):
            status = dict(base, **{field: value})
            with self.subTest(field=field, value=value):
                with self.assertRaisesRegex(control.ControlError, '^invalid_response$'):
                    self.run_command(handler=lambda req: self.reply(req, status=status))
                # Non-finite JSON is malformed and is deliberately preserved.
                if self.response.exists():
                    self.response.unlink()

    def test_symlinks_and_nonprivate_directory_rejected(self):
        target = self.world / 'target'
        target.mkdir(mode=0o700)
        self.directory.rmdir()
        self.directory.symlink_to(target, target_is_directory=True)
        with self.assertRaisesRegex(control.ControlError, '^unsafe_control_path$'):
            self.run_command()
        self.directory.unlink()
        self.directory.mkdir(mode=0o755)
        with self.assertRaisesRegex(control.ControlError, '^unsafe_control_path$'):
            self.run_command()
        self.assertEqual(self.directory.stat().st_mode & 0o777, 0o755)

    def test_response_symlink_not_followed_or_deleted(self):
        target = self.world / 'foreign-data'
        self.write(target, {'secret': 'keep'})
        def respond(request):
            self.response.symlink_to(target)
        with self.assertRaisesRegex(control.ControlError, '^control_io_error$'):
            self.run_command(handler=respond)
        self.assertTrue(self.response.is_symlink())
        self.assertEqual(json.loads(target.read_text()), {'secret': 'keep'})

    def test_response_0644_rejected_and_preserved_even_under_0700_parent(self):
        for mode in (0o644, 0o640, 0o604, 0o620):
            with self.subTest(mode=oct(mode)):
                def respond(request):
                    self.reply(request)
                    self.response.chmod(mode)
                with self.assertRaisesRegex(control.ControlError, '^unsafe_control_path$'):
                    self.run_command(handler=respond)
                self.assertEqual(self.directory.stat().st_mode & 0o777, 0o700)
                self.assertEqual(self.response.stat().st_mode & 0o777, mode)
                self.assertFalse(self.request.exists())
                self.response.unlink()  # Client preserves it; fixture owns cleanup.

    def test_nonprivate_existing_lock_is_not_repaired_or_deleted(self):
        path = self.directory / '.lock'
        path.write_bytes(b'keep')
        path.chmod(0o644)
        inode = path.stat().st_ino
        with self.assertRaisesRegex(control.ControlError, '^unsafe_control_path$'):
            self.run_command(handler=self.reply)
        self.assertEqual(path.stat().st_ino, inode)
        self.assertEqual(path.stat().st_mode & 0o777, 0o644)
        self.assertEqual(path.read_bytes(), b'keep')
        self.assertFalse(self.request.exists())

    def test_runtime_status_has_exactly_four_fields(self):
        def respond(request):
            status = {'logical_time': 42.0, 'rate': 24.0,
                      'paused': False, 'pending_models': 0.0}
            self.reply(request, status=status)
        self.assertTrue(self.run_command(handler=respond)['ok'])
        def extended(request):
            value = self.reply(request)
            value['status']['world_id'] = 'unexpected'
            self.write(self.response, value)
        with self.assertRaisesRegex(control.ControlError, '^invalid_response$'):
            self.run_command(handler=extended)

    def test_main_safe_errors_and_rejection_exit_status(self):
        sink = io.StringIO()
        with patch.object(control, 'send_command', side_effect=control.ControlError('control_timeout')), \
                contextlib.redirect_stdout(sink):
            self.assertEqual(control.main(['--world', str(self.world), '--command', 'status']), 1)
        self.assertEqual(json.loads(sink.getvalue()), {'ok': False, 'error': 'control_timeout'})
        sink = io.StringIO()
        with patch.object(control, 'send_command', return_value={'ok': False, 'error': 'world_frozen'}), \
                contextlib.redirect_stdout(sink):
            self.assertEqual(control.main(['--world', str(self.world), '--command', 'pause']), 1)


if __name__ == '__main__':
    unittest.main()
