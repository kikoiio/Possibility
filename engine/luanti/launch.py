"""Run one Luanti process inside a controlled Wispiva world session.

The session owns the world lock for the complete child lifetime.  This keeps
identity validation and cooperative exclusion at the process boundary instead
of leaving them as a library convention that the launcher could accidentally
skip.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys

# ``run.sh`` executes this file by path, so the repository root is not
# automatically on sys.path as it is when the module is imported by tests.
if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from engine.luanti.world_session import WorldSession
from engine.luanti.recovery_journal import MARKER_FILE, RecoveryRequired, SessionJournal
from world.product_contract import ProductContractError, validate_world_contract


def _forward(child, signum, _frame):
    if child.poll() is None:
        try:
            child.send_signal(signum)
        except ProcessLookupError:
            pass


def _verify_product_checkpoint(world_dir, world_id):
    """Clear the durable session marker only after a clean, matching checkpoint."""
    world = Path(world_dir)
    try:
        path = world / 'mod_storage/society'
        with path.open('rb') as source:
            raw = source.read(32 * 1024 * 1024 + 1)
        if len(raw) > 32 * 1024 * 1024:
            raise ValueError
        fields = json.loads(raw)
        state = json.loads(fields['product_state'])
        agents = json.loads(fields['agent_state'])
        environment = json.loads(fields['environment_state'])
        if (state['world_id'] != world_id or state['phase'] != 'READY' or
                state.get('pending') is not None or fields.get('product_active_run') or
                state['clock']['logical_time'] != environment['time'] or
                state['components']['memory'] != len(agents['long_term']['records']) or
                state['components']['events'] != len(agents['world_events']['events'])):
            raise ValueError
        # The engine has exited. Flush its independent stores before removing
        # the fsynced recovery marker; any failure leaves the world fenced.
        for item in (path, world / 'map.sqlite'):
            fd = os.open(item, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        for directory in (path.parent, world):
            fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    except (OSError, ValueError, KeyError, TypeError):
        raise RecoveryRequired('product checkpoint is incomplete; recovery marker retained') from None


def recover_committed_checkpoint(world_dir, *, expected_world_id=None):
    """Clear a stale session marker only when a complete product commit is durable.

    This repairs the narrow crash window after the product checkpoint committed
    but before the launcher removed its session marker. It never repairs or
    resumes a PREPARING, active, or otherwise incomplete world.
    """
    with WorldSession(world_dir, expected_world_id=expected_world_id) as session:
        validate_world_contract(world_dir, expected_world_id=session.world_id)
        marker = Path(world_dir) / MARKER_FILE
        if not os.path.lexists(marker):
            return None
        _verify_product_checkpoint(world_dir, session.world_id)
        return SessionJournal.acknowledge(world_dir, session.world_id)


def run(command, world_dir, *, create=False, expected_world_id=None, env=None,
        require_product_contract=False, cwd=None):
    """Run *command* while holding the world's exclusive session lock."""
    if not command:
        raise ValueError('missing child command')
    child = None
    with WorldSession(world_dir, create=create,
                      expected_world_id=expected_world_id) as session:
        if require_product_contract:
            validate_world_contract(world_dir, expected_world_id=session.world_id)
        journal = SessionJournal(world_dir, session.world_id)
        journal.begin()
        child_env = dict(os.environ if env is None else env)
        child_env['WISPIVA_WORLD_ID'] = session.world_id
        try:
            child = subprocess.Popen(command, cwd=cwd, env=child_env)
            previous = {}
            for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
                previous[signum] = signal.signal(
                    signum, lambda sig, frame, child=child: _forward(child, sig, frame))
            try:
                status = child.wait()
            finally:
                for signum, handler in previous.items():
                    signal.signal(signum, handler)
                if child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait()
        except BaseException:
            # Process creation, signal handling, or uncertain cleanup must keep
            # the durable marker for the next opener.
            raise
        if status == 0:
            if require_product_contract:
                _verify_product_checkpoint(world_dir, session.world_id)
            journal.finish()
        return status


def main(argv=None):
    parser = argparse.ArgumentParser(
        description='Run a child process inside a controlled Wispiva world session.')
    parser.add_argument('--world', required=True, type=Path)
    parser.add_argument('--create-if-missing', action='store_true')
    parser.add_argument('--expected-world-id')
    parser.add_argument('--require-product-contract', action='store_true')
    parser.add_argument('--recover-committed-checkpoint', action='store_true',
                        help='clear a stale marker only if the committed product checkpoint is complete')
    parser.add_argument('--cwd', type=Path)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    command = list(args.command)
    if command[:1] == ['--']:
        command.pop(0)
    if args.recover_committed_checkpoint:
        if command:
            parser.error('--recover-committed-checkpoint does not accept a child command')
        try:
            session_id = recover_committed_checkpoint(
                args.world, expected_world_id=args.expected_world_id)
            print('wispiva launcher: ' + ('no recovery marker' if session_id is None
                                           else 'committed checkpoint verified; recovery marker cleared'))
            return 0
        except (BlockingIOError, OSError, ValueError, RecoveryRequired, ProductContractError) as error:
            print('wispiva launcher: ' + str(error), file=sys.stderr)
            return 1
    if not command:
        parser.error('a child command is required after --')
    try:
        return run(command, args.world, create=args.create_if_missing,
                   expected_world_id=args.expected_world_id,
                   require_product_contract=args.require_product_contract,
                   cwd=args.cwd)
    except (BlockingIOError, OSError, ValueError, RecoveryRequired, ProductContractError) as error:
        print('wispiva launcher: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
